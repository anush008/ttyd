import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { ClipboardAddon, ClipboardSelectionType, IClipboardProvider } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CursorAddon, CursorShape } from './addons/cursor';
import { OverlayAddon } from './addons/overlay';
import { TouchAddon } from './addons/touch';
import { ZmodemAddon } from './addons/zmodem';

import '@xterm/xterm/css/xterm.css';

interface TtydTerminal extends Terminal {
    fit(): void;
}

declare global {
    interface Window {
        term: TtydTerminal;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',
    PROCESS_EXIT = '3',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}
type Preferences = ITerminalOptions & ClientOptions;

export type RendererType = 'dom' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
    closeOnDisconnect: boolean;
    smoothCursor: boolean;
}

// one-shot modifiers from the extra keys bar, they apply to the next key
export interface Modifiers {
    ctrl: boolean;
    alt: boolean;
}

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
}

// OSC 52: allow programs to set the clipboard, but never let terminal output read it.
// an empty selection (sent by tmux) means the system clipboard too
const writeOnlyClipboard: IClipboardProvider = {
    readText: () => '',
    writeText: async (selection: ClipboardSelectionType, text: string) => {
        if (selection === ClipboardSelectionType.SYSTEM || (selection as string) === '') {
            await navigator.clipboard.writeText(text);
        }
    },
};

// options that may be set from the URL query string, other options are set by the server only
const urlOptions: { [key: string]: 'boolean' | 'number' | 'string' } = {
    fontSize: 'number',
    lineHeight: 'number',
    letterSpacing: 'number',
    cursorBlink: 'boolean',
    cursorStyle: 'string',
    rendererType: 'string',
    unicodeVersion: 'string',
    titleFixed: 'string',
    disableLeaveAlert: 'boolean',
    disableResizeOverlay: 'boolean',
    disableReconnect: 'boolean',
    smoothCursor: 'boolean',
};
const urlOptionValues: { [key: string]: string[] } = {
    cursorStyle: ['block', 'underline', 'bar'],
    rendererType: ['dom', 'webgl'],
    unicodeVersion: ['6', '11'],
};

const FONT_SIZE_KEY = 'ttyd.fontSize';

// the font size that the user set with a pinch on this device
function savedFontSize(): number | undefined {
    try {
        const size = Number(localStorage.getItem(FONT_SIZE_KEY));
        return size > 0 ? size : undefined;
    } catch {
        return undefined;
    }
}

// the control character that ctrl and a key make, eg: ctrl+c is \x03
function ctrlChar(c: string): string {
    if (c === ' ') return '\x00';
    if (c === '?') return '\x7f';
    const code = c.toUpperCase().charCodeAt(0);
    return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : c;
}

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

function addEventListener(target: EventTarget, type: string, listener: EventListener): IDisposable {
    target.addEventListener(type, listener);
    return toDisposable(() => target.removeEventListener(type, listener));
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    private clipboardAddon = new ClipboardAddon(undefined, writeOnlyClipboard);
    private webLinksAddon = new WebLinksAddon();
    private cursorAddon?: CursorAddon;
    private touchAddon?: TouchAddon;
    private webglAddon?: WebglAddon;
    private zmodemAddon?: ZmodemAddon;

    private socket?: WebSocket;
    private token: string;
    private opened = false;
    private title?: string;
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    private closeOnDisconnect = false;
    private exitStatus?: number;
    private modifiers: Modifiers = { ctrl: false, alt: false };
    private fitFrame?: number;

    private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));

    constructor(
        private options: XtermOptions,
        private sendCb: () => void,
        private onModifiers: (modifiers: Modifiers) => void = () => {},
    ) {}

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        this.zmodemAddon?.sendFile(files);
    }

    @bind
    public async refreshToken() {
        try {
            const resp = await fetch(this.options.tokenUrl);
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
        }
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        event.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        return undefined;
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, clipboardAddon, webLinksAddon } = this;
        window.term = terminal as TtydTerminal;
        window.term.fit = () => {
            this.fitAddon.fit();
        };

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(clipboardAddon);
        terminal.loadAddon(webLinksAddon);

        terminal.open(parent);
        fitAddon.fit();

        if (this.options.clientOptions.smoothCursor) {
            this.cursorAddon = new CursorAddon();
            terminal.loadAddon(this.cursorAddon);
        }
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
            this.touchAddon = new TouchAddon(this.setFontSize);
            terminal.loadAddon(this.touchAddon);
        }
        this.syncTheme();
        // fit when the container changes size: window resize, rotation, on-screen keyboard, the keys bar
        new ResizeObserver(this.scheduleFit).observe(parent);
    }

    @bind
    private scheduleFit() {
        if (this.fitFrame) return;
        this.fitFrame = requestAnimationFrame(() => {
            this.fitFrame = undefined;
            this.fitAddon.fit();
        });
    }

    // fill the page around the terminal with the terminal background
    @bind
    private syncTheme() {
        const background = this.terminal.options.theme?.background;
        if (background) {
            document.body.style.backgroundColor = background;
            document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
        }
        this.cursorAddon?.syncTheme();
    }

    @bind
    private setFontSize(size: number) {
        this.terminal.options.fontSize = size;
        this.fitAddon.fit();
        this.overlayAddon.showOverlay(`${size}px`, 400);
        try {
            localStorage.setItem(FONT_SIZE_KEY, String(size));
        } catch {
            // the size is not kept, eg: in a private window
        }
    }

    @bind
    public toggleModifier(mod: keyof Modifiers) {
        this.modifiers = { ...this.modifiers, [mod]: !this.modifiers[mod] };
        this.onModifiers(this.modifiers);
    }

    private takeModifiers(): Modifiers {
        const modifiers = this.modifiers;
        if (modifiers.ctrl || modifiers.alt) {
            this.modifiers = { ctrl: false, alt: false };
            this.onModifiers(this.modifiers);
        }
        return modifiers;
    }

    // apply the latched modifiers to text typed on the on-screen keyboard
    private applyModifiers(data: string): string {
        // escape sequences come from a hardware keyboard or the mouse, they keep their own modifiers
        if ((!this.modifiers.ctrl && !this.modifiers.alt) || data === '' || data[0] === '\x1b') return data;
        const { ctrl, alt } = this.takeModifiers();
        const [first, ...rest] = Array.from(data);
        return (alt ? '\x1b' : '') + (ctrl ? ctrlChar(first) : first) + rest.join('');
    }

    // a key from the extra keys bar
    @bind
    public sendKey(key: string) {
        const { ctrl, alt } = this.takeModifiers();
        const mod = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
        const app = this.terminal.modes.applicationCursorKeysMode;
        const cursor: { [key: string]: string } = {
            ArrowUp: 'A',
            ArrowDown: 'B',
            ArrowRight: 'C',
            ArrowLeft: 'D',
            Home: 'H',
            End: 'F',
        };
        let seq: string;
        if (cursor[key]) {
            seq = mod > 1 ? `\x1b[1;${mod}${cursor[key]}` : `\x1b${app ? 'O' : '['}${cursor[key]}`;
        } else if (key === 'PageUp' || key === 'PageDown') {
            seq = `\x1b[${key === 'PageUp' ? 5 : 6}${mod > 1 ? `;${mod}` : ''}~`;
        } else {
            const plain = key === 'Escape' ? '\x1b' : key === 'Tab' ? '\t' : ctrl ? ctrlChar(key) : key;
            seq = (alt ? '\x1b' : '') + plain;
        }
        this.terminal.input(seq, true);
    }

    @bind
    public async paste() {
        try {
            const text = await navigator.clipboard.readText();
            if (text) this.terminal.paste(text);
        } catch {
            this.overlayAddon.showOverlay('Allow clipboard access to paste', 1500);
        }
    }

    @bind
    private initListeners() {
        const { terminal, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                if (data && data !== '' && !this.titleFixed) {
                    document.title = data + ' | ' + this.title;
                }
            }),
        );
        register(terminal.onData(data => sendData(this.applyModifiers(data))));
        register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            }),
        );
        register(
            terminal.onSelectionChange(() => {
                if (this.terminal.getSelection() === '') return;
                try {
                    document.execCommand('copy');
                } catch {
                    return;
                }
                this.overlayAddon?.showOverlay('\u2702', 200);
            }),
        );
        register(addEventListener(window, 'beforeunload', this.onWindowUnload));
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                if (this.pending < lowWater && this.socket?.readyState === WebSocket.OPEN) {
                    this.socket.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater && this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public sendData(data: string | Uint8Array) {
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    @bind
    public connect() {
        this.socket = new WebSocket(this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        register(addEventListener(socket, 'open', this.onSocketOpen));
        register(addEventListener(socket, 'message', this.onSocketData as EventListener));
        register(addEventListener(socket, 'close', this.onSocketClose as EventListener));
        register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        const { textEncoder, terminal, overlayAddon } = this;
        const msg = JSON.stringify({ AuthToken: this.token, columns: terminal.cols, rows: terminal.rows });
        this.socket?.send(textEncoder.encode(msg));

        if (this.opened) {
            terminal.reset();
            this.cursorAddon?.reset();
            terminal.options.disableStdin = false;
            overlayAddon.showOverlay('Reconnected', 300);
        } else {
            this.opened = true;
        }

        this.doReconnect = this.reconnect;
        this.initListeners();
        terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        // after the process exited, the client closed the connection, use the status that the server sent
        const code = this.exitStatus ?? event.code;
        this.exitStatus = undefined;
        console.log(`[ttyd] websocket connection closed with code: ${code}`);

        const { refreshToken, connect, doReconnect, overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.dispose();

        // 1000: CLOSE_NORMAL
        if (code !== 1000 && doReconnect) {
            overlayAddon.showOverlay('Reconnecting...');
            void refreshToken().then(connect);
        } else if (this.closeOnDisconnect) {
            window.close();
        } else {
            const { terminal } = this;
            const keyDispose = terminal.onKey(e => {
                const event = e.domEvent;
                if (event.key === 'Enter') {
                    keyDispose.dispose();
                    overlayAddon.showOverlay('Reconnecting...');
                    void refreshToken().then(connect);
                }
            });
            overlayAddon.showOverlay('Press ⏎ to Reconnect');
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const prefs = {} as Preferences;
        const queryObj = Array.from(new URLSearchParams(query) as unknown as Iterable<[string, string]>);

        for (const [k, queryVal] of queryObj) {
            if (!Object.prototype.hasOwnProperty.call(urlOptions, k)) {
                if (k !== 'arg') console.warn(`[ttyd] ignored url option: ${k}`);
                continue;
            }
            const allowed = urlOptionValues[k];
            if (allowed && !allowed.includes(queryVal)) {
                console.warn(`[ttyd] ignored url option: ${k}=${queryVal}`);
                continue;
            }
            switch (urlOptions[k]) {
                case 'boolean':
                    prefs[k] = queryVal === 'true' || queryVal === '1';
                    break;
                case 'number': {
                    const v = Number.parseFloat(queryVal);
                    if (Number.isFinite(v) && v > 0 && v <= 100) prefs[k] = v;
                    break;
                }
                case 'string':
                    prefs[k] = queryVal;
                    break;
            }
        }

        return prefs;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
                this.writeFunc(data);
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                document.title = this.title;
                break;
            case Command.PROCESS_EXIT:
                // the process exited and all output came before this message, so close the connection now.
                // the server waits for this, a close from the server could make the browser drop unread output.
                this.exitStatus = Number.parseInt(textDecoder.decode(data), 10) || 1000;
                this.socket?.close(1000);
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, fitAddon, register } = this;
        if (prefs.enableZmodem || prefs.enableTrzsz) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data => this.zmodemAddon?.consume(data);
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of Object.entries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        window.removeEventListener('beforeunload', this.onWindowUnload);
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        terminal.loadAddon(register(new ImageAddon()));
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'closeOnDisconnect':
                    if (value) {
                        console.log('[ttyd] close on disconnect enabled (Reconnect disabled)');
                        this.closeOnDisconnect = true;
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'titleFixed':
                    if (!value || value === '') break;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    document.title = value;
                    break;
                case 'smoothCursor':
                    if (!value && this.cursorAddon) {
                        this.cursorAddon.dispose();
                        this.cursorAddon = undefined;
                        console.log('[ttyd] smooth cursor disabled');
                    }
                    break;
                case 'cursorStyle':
                    if (this.cursorAddon) this.cursorAddon.setDefaultShape(value as CursorShape);
                    else terminal.options.cursorStyle = value;
                    break;
                case 'cursorBlink':
                    if (this.cursorAddon) this.cursorAddon.setDefaultBlink(value);
                    else terminal.options.cursorBlink = value;
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) fitAddon.fit();
                    if (key === 'theme') this.syncTheme();
                    break;
            }
        }

        // a size that the user picked with a pinch on this device wins over the server default
        const fontSize = savedFontSize();
        if (fontSize && fontSize !== terminal.options.fontSize) {
            terminal.options.fontSize = fontSize;
            fitAddon.fit();
        }
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            try {
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon?.dispose();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to dom renderer', e);
                disposeWebglRenderer();
            }
        };

        switch (value) {
            case 'webgl':
                enableWebglRenderer();
                break;
            case 'dom':
            default:
                disposeWebglRenderer();
                console.log('[ttyd] dom renderer loaded');
                break;
        }
    }
}
