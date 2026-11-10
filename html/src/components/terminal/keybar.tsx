import { h, Component } from 'preact';
import type { Modifiers } from './xterm';

interface Key {
    label: string;
    key?: string; // a key for Xterm.sendKey
    mod?: keyof Modifiers;
    paste?: boolean;
    repeat?: boolean;
    title?: string;
}

const KEYS: Key[] = [
    { label: 'esc', key: 'Escape' },
    { label: 'tab', key: 'Tab' },
    { label: 'ctrl', mod: 'ctrl' },
    { label: 'alt', mod: 'alt' },
    { label: '←', key: 'ArrowLeft', repeat: true, title: 'Left' },
    { label: '↑', key: 'ArrowUp', repeat: true, title: 'Up' },
    { label: '↓', key: 'ArrowDown', repeat: true, title: 'Down' },
    { label: '→', key: 'ArrowRight', repeat: true, title: 'Right' },
    { label: '|', key: '|' },
    { label: '-', key: '-' },
    { label: '/', key: '/' },
    { label: '~', key: '~' },
    { label: 'home', key: 'Home' },
    { label: 'end', key: 'End' },
    { label: 'pgup', key: 'PageUp', repeat: true },
    { label: 'pgdn', key: 'PageDown', repeat: true },
    { label: 'paste', paste: true },
];

const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 60;

interface Props {
    modifiers: Modifiers;
    onKey: (key: string) => void;
    onModifier: (mod: keyof Modifiers) => void;
    onPaste: () => void;
}

// extra keys for touch screens, the on-screen keyboard has no esc, tab, ctrl, alt or arrows
export class KeyBar extends Component<Props> {
    private timer?: number;
    private repeated = false;

    componentWillUnmount() {
        this.stopRepeat();
    }

    render({ modifiers }: Props) {
        return (
            <div class="ttyd-keybar" role="toolbar" aria-label="Extra keys">
                {KEYS.map(k => (
                    <button
                        key={k.label}
                        type="button"
                        tabIndex={-1}
                        title={k.title}
                        aria-pressed={k.mod ? modifiers[k.mod] : undefined}
                        class={k.mod && modifiers[k.mod] ? 'on' : undefined}
                        // keep the focus in the terminal, so the on-screen keyboard stays open
                        onMouseDown={e => e.preventDefault()}
                        onPointerDown={() => this.startRepeat(k)}
                        onPointerUp={() => this.release(k)}
                        onPointerCancel={() => this.stopRepeat()}
                        onPointerLeave={() => this.stopRepeat()}
                    >
                        {k.label}
                    </button>
                ))}
            </div>
        );
    }

    private press(k: Key) {
        const { onKey, onModifier, onPaste } = this.props;
        if (k.mod) onModifier(k.mod);
        else if (k.paste) onPaste();
        else if (k.key) onKey(k.key);
    }

    // a held key repeats, a tap acts on release, so scrolling the bar does not press keys
    private startRepeat(k: Key) {
        this.stopRepeat();
        this.repeated = false;
        if (!k.repeat) return;
        this.timer = window.setTimeout(() => {
            this.repeated = true;
            this.press(k);
            this.timer = window.setInterval(() => this.press(k), REPEAT_INTERVAL);
        }, REPEAT_DELAY);
    }

    private release(k: Key) {
        const repeated = this.repeated;
        this.stopRepeat();
        if (!repeated) this.press(k);
    }

    private stopRepeat() {
        if (this.timer) {
            clearTimeout(this.timer);
            clearInterval(this.timer);
        }
        this.timer = undefined;
        this.repeated = false;
    }
}
