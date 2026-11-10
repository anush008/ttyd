// draws the cursor as one element over the terminal, so it can glide between cells and fade when it blinks.
// the native cursor stays an invisible bar, a native block would draw the character under it in the background color.
import { bind } from 'decko';
import type { IDisposable, ITerminalAddon, ITheme, Terminal } from '@xterm/xterm';

export type CursorShape = 'block' | 'underline' | 'bar';

// the cursor stays solid this long after it moved, then it starts to blink
const BLINK_DELAY = 600;
// xterm.js parses hex colors only, a fully transparent one hides the native cursor
const HIDDEN = '#00000000';

export class CursorAddon implements ITerminalAddon {
    private terminal: Terminal;
    private screen?: HTMLElement;
    private node = document.createElement('div');
    private disposables: IDisposable[] = [];
    private resizeObserver?: ResizeObserver;

    private defaultShape: CursorShape = 'bar';
    private defaultBlink = true;
    // set by the program with DECSCUSR, undefined means the default
    private shape?: CursorShape;
    private blink?: boolean;
    private color = '#ffffff';
    private hidden = false;
    private focused = false;
    private cellWidth = 0;
    private cellHeight = 0;

    private frame?: number;
    private blinkTimer?: number;
    private jump = true;
    private last = '';

    activate(terminal: Terminal): void {
        this.terminal = terminal;
        const { node } = this;
        node.className = 'ttyd-cursor';
        node.setAttribute('aria-hidden', 'true');

        const { options, parser, textarea } = terminal;
        this.defaultShape = options.cursorStyle ?? 'bar';
        this.defaultBlink = options.cursorBlink ?? true;
        options.cursorStyle = 'bar';
        options.cursorBlink = false;
        options.cursorInactiveStyle = 'none';
        this.syncTheme();

        const showCursor = (show: boolean) => (params: (number | number[])[]) => {
            if (params.includes(25)) {
                this.hidden = !show;
                this.schedule();
            }
            return false;
        };
        const reset = () => {
            this.reset();
            return false;
        };
        this.disposables.push(
            parser.registerCsiHandler({ prefix: '?', final: 'h' }, showCursor(true)),
            parser.registerCsiHandler({ prefix: '?', final: 'l' }, showCursor(false)),
            parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, this.setCursorStyle),
            parser.registerCsiHandler({ intermediates: '!', final: 'p' }, reset),
            parser.registerEscHandler({ final: 'c' }, reset),
            terminal.onCursorMove(this.onMove),
            terminal.onRender(this.schedule),
            terminal.onScroll(this.onJump),
            terminal.onResize(this.onJump),
            terminal.buffer.onBufferChange(this.onJump),
        );

        if (textarea) {
            const onFocus = () => this.setFocus(true);
            const onBlur = () => this.setFocus(false);
            textarea.addEventListener('focus', onFocus);
            textarea.addEventListener('blur', onBlur);
            this.disposables.push({
                dispose: () => {
                    textarea.removeEventListener('focus', onFocus);
                    textarea.removeEventListener('blur', onBlur);
                },
            });
            this.focused = document.activeElement === textarea;
        }

        terminal.element?.classList.add('ttyd-smooth-cursor');
        this.screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? undefined;
        if (this.screen) {
            this.screen.appendChild(node);
            // the cell size changes with the font and the window, read it only then
            this.resizeObserver = new ResizeObserver(this.measure);
            this.resizeObserver.observe(this.screen);
            this.measure();
        }
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables.length = 0;
        this.resizeObserver?.disconnect();
        if (this.frame) cancelAnimationFrame(this.frame);
        if (this.blinkTimer) clearTimeout(this.blinkTimer);
        this.node.remove();
        this.terminal.element?.classList.remove('ttyd-smooth-cursor');

        const { options } = this.terminal;
        options.cursorStyle = this.defaultShape;
        options.cursorBlink = this.defaultBlink;
        options.cursorInactiveStyle = 'outline';
        options.theme = { ...options.theme, cursor: this.color };
    }

    // take the cursor color from the theme, then hide the native cursor
    @bind
    public syncTheme() {
        const theme: ITheme = this.terminal.options.theme ?? {};
        if (theme.cursor && theme.cursor !== HIDDEN) this.color = theme.cursor;
        else if (!theme.cursor && theme.foreground) this.color = theme.foreground;
        this.node.style.setProperty('--cursor-color', this.color);
        if (theme.cursor !== HIDDEN) this.terminal.options.theme = { ...theme, cursor: HIDDEN };
    }

    public setDefaultShape(shape: CursorShape) {
        this.defaultShape = shape;
        this.schedule();
    }

    public setDefaultBlink(blink: boolean) {
        this.defaultBlink = blink;
        this.schedule();
    }

    // the terminal was reset, so the cursor is visible again with the default shape
    @bind
    public reset() {
        this.hidden = false;
        this.shape = this.blink = undefined;
        this.onJump();
    }

    // DECSCUSR: CSI Ps SP q
    @bind
    private setCursorStyle(params: (number | number[])[]): boolean {
        const ps = typeof params[0] === 'number' ? params[0] : 0;
        const shapes: CursorShape[] = ['block', 'block', 'underline', 'underline', 'bar', 'bar'];
        if (ps < 1 || ps > 6) {
            this.shape = this.blink = undefined;
        } else {
            this.shape = shapes[ps - 1];
            this.blink = ps % 2 === 1;
        }
        this.schedule();
        return true;
    }

    @bind
    private measure() {
        const { screen, terminal } = this;
        if (!screen || !terminal.cols || !terminal.rows) return;
        this.cellWidth = screen.clientWidth / terminal.cols;
        this.cellHeight = screen.clientHeight / terminal.rows;
        this.onJump();
    }

    @bind
    private setFocus(focused: boolean) {
        this.focused = focused;
        this.schedule();
    }

    @bind
    private onMove() {
        // solid while the user types, blink after a short pause
        if (this.blinkTimer) clearTimeout(this.blinkTimer);
        this.blinkTimer = window.setTimeout(() => {
            this.blinkTimer = undefined;
            this.schedule();
        }, BLINK_DELAY);
        this.schedule();
    }

    // the text moved under the cursor, so place the cursor without a glide
    @bind
    private onJump() {
        this.jump = true;
        this.schedule();
    }

    @bind
    private schedule() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(this.update);
    }

    @bind
    private update() {
        this.frame = undefined;
        const { terminal, node, cellWidth, cellHeight } = this;
        if (!cellWidth || !cellHeight) return;

        const buffer = terminal.buffer.active;
        const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
        const visible = !this.hidden && row >= 0 && row < terminal.rows;

        const col = Math.min(buffer.cursorX, terminal.cols - 1);
        const wide =
            visible &&
            buffer
                .getLine(buffer.baseY + buffer.cursorY)
                ?.getCell(col)
                ?.getWidth() === 2;
        const shape = this.focused ? (this.shape ?? this.defaultShape) : 'block';
        const blink = this.focused && (this.blink ?? this.defaultBlink) && this.blinkTimer === undefined;

        let width = cellWidth * (wide ? 2 : 1);
        let height = cellHeight;
        let top = row * cellHeight;
        if (shape === 'bar') {
            width = Math.max(2, Math.round(cellWidth / 7));
        } else if (shape === 'underline') {
            height = Math.max(2, Math.round(cellHeight / 10));
            top += cellHeight - height;
        }

        const glide = !this.jump;
        this.jump = false;
        const className = `ttyd-cursor ${shape} ${this.focused ? 'focus' : 'blur'}${glide ? ' glide' : ''}${blink ? ' blink' : ''}${visible ? '' : ' hidden'}`;
        const transform = `translate(${col * cellWidth}px,${top}px)`;
        const state = `${className}|${transform}|${width}|${height}`;
        // skip the DOM writes when nothing changed, onRender fires for every frame of output
        if (state === this.last) return;
        this.last = state;
        node.className = className;
        node.style.transform = transform;
        node.style.width = `${width}px`;
        node.style.height = `${height}px`;
    }
}
