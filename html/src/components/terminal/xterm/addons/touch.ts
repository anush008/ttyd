// touch gestures: swipe to scroll with momentum, pinch to change the font size
import { bind } from 'decko';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

// a touch that moves less than this is a tap, the terminal handles it as a click
const TAP_SLOP = 8;
// momentum slows down by this factor every 16 ms, and stops below this speed in px/ms
const FRICTION = 0.95;
const MIN_SPEED = 0.02;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;

export class TouchAddon implements ITerminalAddon {
    private terminal: Terminal;
    private disposables: IDisposable[] = [];

    private startY = 0;
    private lastY = 0;
    private lastTime = 0;
    private velocity = 0;
    private scrolling = false;
    private pending = 0; // pixels that did not add up to a full line yet
    private momentum?: number;

    private pinchDistance = 0;
    private pinchFontSize = 0;
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
        this.stopMomentum();
    }

    @bind
    private onTouchStart(e: TouchEvent) {
        this.stopMomentum();
        if (e.touches.length === 2) {
            this.scrolling = false;
            this.pinchDistance = distance(e.touches);
            this.pinchFontSize = this.terminal.options.fontSize ?? 14;
            e.preventDefault();
            return;
        }
        if (e.touches.length !== 1) return;
        this.startY = this.lastY = e.touches[0].clientY;
        this.lastTime = e.timeStamp;
        this.velocity = 0;
        this.pending = 0;
        this.scrolling = false;
    }

    @bind
    private onTouchMove(e: TouchEvent) {
        if (e.touches.length === 2 && this.pinchDistance > 0) {
            e.preventDefault();
            const scale = distance(e.touches) / this.pinchDistance;
            const size = Math.round(clamp(this.pinchFontSize * scale, MIN_FONT_SIZE, MAX_FONT_SIZE));
            if (size !== this.terminal.options.fontSize && !this.pinchFrame) {
                this.pinchFrame = requestAnimationFrame(() => {
                    this.pinchFrame = undefined;
                    this.onFontSize(size);
                });
            }
            return;
        }
        if (e.touches.length !== 1) return;

        const y = e.touches[0].clientY;
        if (!this.scrolling && Math.abs(y - this.startY) < TAP_SLOP) return;
        this.scrolling = true;
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
        if (e.touches.length > 0) return;
        this.pinchDistance = 0;
        if (!this.scrolling) return;
        this.scrolling = false;
        e.preventDefault();
        // a finger that rested before it lifted gets no momentum
        if (e.timeStamp - this.lastTime > 80 || Math.abs(this.velocity) < MIN_SPEED) return;

        let last = performance.now();
        const step = (now: number) => {
            const dt = now - last;
            last = now;
            this.velocity *= Math.pow(FRICTION, dt / 16);
            if (Math.abs(this.velocity) < MIN_SPEED) {
                this.momentum = undefined;
                return;
            }
            this.scrollBy(-this.velocity * dt);
            this.momentum = requestAnimationFrame(step);
        };
        this.momentum = requestAnimationFrame(step);
    }

    private stopMomentum() {
        if (this.momentum) cancelAnimationFrame(this.momentum);
        this.momentum = undefined;
    }

    // scroll by a distance in pixels, positive scrolls down
    private scrollBy(pixels: number) {
        const { terminal } = this;
        const el = terminal.element;
        if (!el) return;

        // programs that use the mouse or the alternate screen (tmux, vim, less) get wheel events,
        // the terminal turns them into mouse wheel input or arrow keys
        if (terminal.modes.mouseTrackingMode !== 'none' || terminal.buffer.active.type === 'alternate') {
            const rect = el.getBoundingClientRect();
            el.dispatchEvent(
                new WheelEvent('wheel', {
                    deltaY: pixels,
                    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    bubbles: true,
                    cancelable: true,
                }),
            );
            return;
        }

        // the shell scrolls the scrollback by whole lines
        const lineHeight = el.querySelector('.xterm-screen')!.clientHeight / terminal.rows;
        this.pending += pixels;
        const lines = Math.trunc(this.pending / lineHeight);
        if (lines !== 0) {
            this.pending -= lines * lineHeight;
            terminal.scrollLines(lines);
        }
        // stop the momentum at the top and the bottom of the scrollback
        const buffer = terminal.buffer.active;
        if (lines !== 0 && (buffer.viewportY <= 0 || buffer.viewportY >= buffer.baseY)) this.velocity = 0;
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
