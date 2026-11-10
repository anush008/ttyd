import { h, Component } from 'preact';

import { Terminal } from './terminal';

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { ClientOptions, FlowControl } from './terminal/xterm';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const path = window.location.pathname.replace(/[/]+$/, '');
const wsUrl = [protocol, '//', window.location.host, path, '/ws', window.location.search].join('');
const tokenUrl = [window.location.protocol, '//', window.location.host, path, '/token'].join('');
const clientOptions = {
    rendererType: 'webgl',
    disableLeaveAlert: false,
    disableResizeOverlay: false,
    enableZmodem: false,
    enableTrzsz: false,
    enableSixel: false,
    closeOnDisconnect: false,
    isWindows: false,
    unicodeVersion: '11',
    smoothCursor: true,
} as ClientOptions;
const termOptions = {
    fontSize: 14,
    // system fonts, so the page downloads no font
    fontFamily:
        'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: 1.15,
    cursorStyle: 'bar',
    cursorBlink: true,
    drawBoldTextInBrightColors: false,
    smoothScrollDuration: 100,
    scrollback: 5000,
    theme: {
        foreground: '#d4d8e0',
        background: '#16181d',
        cursor: '#7cc4ff',
        cursorAccent: '#16181d',
        selectionBackground: '#7cc4ff4d',
        scrollbarSliderBackground: '#ffffff1f',
        scrollbarSliderHoverBackground: '#ffffff33',
        scrollbarSliderActiveBackground: '#ffffff47',
        black: '#1f2229',
        red: '#ef6b73',
        green: '#8bd17c',
        yellow: '#e6c16d',
        blue: '#6aa7f8',
        magenta: '#c493ef',
        cyan: '#58cfd0',
        white: '#c9cdd6',
        brightBlack: '#646b7a',
        brightRed: '#ff8890',
        brightGreen: '#a6e59a',
        brightYellow: '#f3d58e',
        brightBlue: '#8ec0ff',
        brightMagenta: '#d6b0ff',
        brightCyan: '#7fe3e3',
        brightWhite: '#f3f5f9',
    } as ITheme,
    allowProposedApi: true,
} as ITerminalOptions;
const flowControl = {
    limit: 100000,
    highWater: 10,
    lowWater: 4,
} as FlowControl;

export class App extends Component {
    render() {
        return (
            <Terminal
                id="terminal-container"
                wsUrl={wsUrl}
                tokenUrl={tokenUrl}
                clientOptions={clientOptions}
                termOptions={termOptions}
                flowControl={flowControl}
            />
        );
    }
}
