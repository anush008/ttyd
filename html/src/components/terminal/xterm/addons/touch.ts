// touch gestures: swipe to scroll with momentum, pinch to change the font size
import { bind } from 'decko';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

// a touch that moves less than this is a tap, the terminal handles it as a click
const TAP_SLOP = 8;
// momentum slows down by this factor every 16 ms, and stops below this speed in px/ms
const FRICTION = 0.95;
const MIN_SPEED = 0.02;
// programs that use the mouse get one wheel report for this many lines of finger travel,
// most programs scroll three lines for each report
const LINES_PER_WHEEL = 3;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 40;

export class TouchAddon implements ITerminalAddon {
    private terminal: Terminal;
    private disposables: IDisposable[] = [];

    private startY = 0;
    private lastY = 0;
    private lastTime = 0;
    private velocity = 0;
    private scrolling = false;
    // after a pinch, the finger that stays on the screen does not scroll
    private ignoreUntilLift = false;
    private lineHeight = 0;
    private pending = 0; // finger travel in pixels that did not add up to a full step yet
    private target = 0; // the scrollback line the viewport goes to
    private smoothScrollDuration?: number;
    private momentum?: number;

    private pinchDistance = 0;
    private pinchFontSize = 0;
    private pinchSize = 0;
    private pinchFrame?: number;

    constructor(private onFontSize: (size: number) => void) {}

    activate(terminal: Terminal): void {
        this.terminal = terminal;
        const el = terminal.element;
        if (!el) return;
        const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
            el.addEventListener(type, fn, { passive: false });
            this.disposables.push({ dispose: () => el.removeEventListener(type, fn) });
        };
        listen('touchstart', this.onTouchStart);
        listen('touchmove', this.onTouchMove);
        listen('touchend', this.onTouchEnd);
        listen('touchcancel', this.onTouchEnd);
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables.length = 0;
        this.endGesture();
        if (this.pinchFrame) cancelAnimationFrame(this.pinchFrame);
    }

    @bind
    private onTouchStart(e: TouchEvent) {
        this.stopMomentum();
        if (e.touches.length === 2) {
            this.scrolling = false;
            this.ignoreUntilLift = true;
            this.pinchDistance = distance(e.touches);
            this.pinchFontSize = this.terminal.options.fontSize ?? 14;
            e.preventDefault();
            return;
        }
        if (e.touches.length !== 1) return;

        const screen = this.terminal.element?.querySelector('.xterm-screen');
        this.lineHeight = screen ? screen.getBoundingClientRect().height / this.terminal.rows : 0;
        this.startY = this.lastY = e.touches[0].clientY;
        this.lastTime = e.timeStamp;
        this.velocity = 0;
        this.pending = 0;
        this.target = this.terminal.buffer.active.viewportY;
        this.scrolling = false;
        this.ignoreUntilLift = false;
    }

    @bind
    private onTouchMove(e: TouchEvent) {
        if (e.touches.length === 2 && this.pinchDistance > 0) {
            e.preventDefault();
            const scale = distance(e.touches) / this.pinchDistance;
            this.pinchSize = Math.round(clamp(this.pinchFontSize * scale, MIN_FONT_SIZE, MAX_FONT_SIZE));
            // apply the newest size once a frame
            if (!this.pinchFrame) {
                this.pinchFrame = requestAnimationFrame(() => {
                    this.pinchFrame = undefined;
                    if (this.pinchSize !== this.terminal.options.fontSize) this.onFontSize(this.pinchSize);
                });
            }
            return;
        }
        if (e.touches.length !== 1 || this.ignoreUntilLift || !this.lineHeight) return;

        const y = e.touches[0].clientY;
        if (!this.scrolling && Math.abs(y - this.startY) < TAP_SLOP) return;
        if (!this.scrolling) this.startGesture();
        e.preventDefault();

        const dy = y - this.lastY;
        const dt = Math.max(1, e.timeStamp - this.lastTime);
        // smooth the speed over the last moves, so a lifted finger does not stop the momentum
        this.velocity = 0.8 * (dy / dt) + 0.2 * this.velocity;
        this.lastY = y;
        this.lastTime = e.timeStamp;
        this.scrollBy(-dy);
    }

    @bind
    private onTouchEnd(e: TouchEvent) {
        if (e.touches.length > 0) {
            // one finger of a pinch lifted, the other one must not scroll from stale coordinates
            if (this.pinchDistance > 0) this.pinchDistance = 0;
            return;
        }
        this.pinchDistance = 0;
        this.ignoreUntilLift = false;
        if (!this.scrolling) return;
        this.scrolling = false;
        e.preventDefault();
        // a finger that rested before it lifted gets no momentum
        if (e.timeStamp - this.lastTime > 80 || Math.abs(this.velocity) < MIN_SPEED) {
            this.endGesture();
            return;
        }

        let last = performance.now();
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            this.velocity *= Math.pow(FRICTION, dt / 16);
            if (Math.abs(this.velocity) < MIN_SPEED || !this.scrollBy(-this.velocity * dt)) {
                this.momentum = undefined;
                this.endGesture();
                return;
            }
            this.momentum = requestAnimationFrame(step);
        };
        this.momentum = requestAnimationFrame(step);
    }

    // the viewport follows the finger at once, a smooth scroll animation would lag behind it
    private startGesture() {
        this.scrolling = true;
        if (this.smoothScrollDuration === undefined) {
            this.smoothScrollDuration = this.terminal.options.smoothScrollDuration ?? 0;
            this.terminal.options.smoothScrollDuration = 0;
        }
    }

    private endGesture() {
        this.stopMomentum();
        if (this.smoothScrollDuration !== undefined) {
            this.terminal.options.smoothScrollDuration = this.smoothScrollDuration;
            this.smoothScrollDuration = undefined;
        }
    }

    private stopMomentum() {
        if (this.momentum) cancelAnimationFrame(this.momentum);
        this.momentum = undefined;
    }

    // scroll by a finger travel in pixels, positive scrolls down. returns false at the end of the scrollback.
    private scrollBy(pixels: number): boolean {
        const { terminal } = this;
        const buffer = terminal.buffer.active;
        const mouse = terminal.modes.mouseTrackingMode !== 'none';
        const step = mouse ? this.lineHeight * LINES_PER_WHEEL : this.lineHeight;
        this.pending += pixels;
        const steps = Math.trunc(this.pending / step);
        if (steps === 0) return true;
        this.pending -= steps * step;

        // the program reads the mouse (tmux, vim with mouse=a): one wheel report for each step
        if (mouse) {
            this.wheel(steps);
            return true;
        }
        // full screen programs without the mouse (less, vim): arrow keys, as a wheel does in xterm
        if (buffer.type === 'alternate') {
            const arrow = `\x1b${terminal.modes.applicationCursorKeysMode ? 'O' : '['}${steps < 0 ? 'A' : 'B'}`;
            terminal.input(arrow.repeat(Math.abs(steps)), true);
            return true;
        }
        // the shell: scroll the scrollback, keep our own target so a running scroll never lags
        const target = clamp(this.target + steps, 0, buffer.baseY);
        if (target === this.target) return false;
        this.target = target;
        terminal.scrollToLine(target);
        return true;
    }

    private wheel(steps: number) {
        const el = this.terminal.element;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        for (let i = 0; i < Math.abs(steps); i++) {
            el.dispatchEvent(
                new WheelEvent('wheel', {
                    deltaY: Math.sign(steps),
                    deltaMode: WheelEvent.DOM_DELTA_LINE,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        }
    }
}

function distance(touches: TouchList) {
    const a = touches[0];
    const b = touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function clamp(v: number, min: number, max: number) {
    return Math.min(max, Math.max(min, v));
}
