import { bind } from 'decko';
import { Component, h } from 'preact';
import { Modifiers, touchScreen, Xterm, XtermOptions } from './xterm';
import { KeyBar } from './keybar';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    modifiers: Modifiers;
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;

    constructor(props: Props) {
        super();
        this.state = { modal: false, modifiers: { ctrl: false, alt: false } };
        this.xterm = new Xterm(props, this.showModal, modifiers => this.setState({ modifiers }));
    }

    async componentDidMount() {
        window.visualViewport?.addEventListener('resize', this.fitViewport);
        this.fitViewport();
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
    }

    componentWillUnmount() {
        window.visualViewport?.removeEventListener('resize', this.fitViewport);
        this.xterm.destroy();
    }

    render({ id }: Props, { modal, modifiers }: State) {
        return (
            <div id={id}>
                <div
                    class="terminal-host"
                    ref={c => {
                        this.container = c as HTMLElement;
                    }}
                />
                {touchScreen && (
                    <KeyBar
                        modifiers={modifiers}
                        onKey={this.xterm.sendKey}
                        onModifier={this.xterm.toggleModifier}
                        onPaste={this.xterm.paste}
                    />
                )}
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
            </div>
        );
    }

    // keep the terminal above the on-screen keyboard: some mobile browsers shrink only the visual viewport
    @bind
    fitViewport() {
        const vv = window.visualViewport;
        if (!vv || Math.abs(vv.scale - 1) > 0.01) return;
        document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
        if (window.scrollY !== 0) window.scrollTo(0, 0);
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
