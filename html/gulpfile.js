const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { task, series } = require('gulp');

const dist = path.join(__dirname, 'dist');

const genHeader = (size, buf, len) => {
    let idx = 0;
    let data = 'unsigned char index_html[] = {\n  ';

    for (const value of buf) {
        idx++;

        const current = value < 0 ? value + 256 : value;

        data += '0x';
        data += (current >>> 4).toString(16);
        data += (current & 0xf).toString(16);

        if (idx === len) {
            data += '\n';
        } else {
            data += idx % 12 === 0 ? ',\n  ' : ', ';
        }
    }

    data += '};\n';
    data += `unsigned int index_html_len = ${len};\n`;
    data += `unsigned int index_html_size = ${size};\n`;
    return data;
};
// replace the `inline` marked tags of dist/index.html with the content of the files they reference
const inlineHtml = html => {
    const read = file => fs.readFileSync(path.join(dist, path.basename(file)));
    return html
        .replace(/<link inline ([^>]*?)href="([^"]+)"([^>]*)>/g, (tag, before, file, after) => {
            if (/rel="stylesheet"/.test(before + after)) {
                return `<style type="text/css">${read(file).toString()}</style>`;
            }
            const type = (/type="([^"]+)"/.exec(before + after) || [])[1] || 'application/octet-stream';
            return `<link ${before}href="data:${type};base64,${read(file).toString('base64')}"${after}>`;
        })
        .replace(/<script inline ([^>]*?)src="([^"]+)"([^>]*)><\/script>/g, (tag, before, file, after) => {
            const js = read(file)
                .toString()
                .replace(/\n\/\/# sourceMappingURL=.*$/, '')
                .replace(/<\/script/gi, '<\\/script');
            return `<script ${before.trim()}${after}>${js}</script>`;
        });
};

task('clean', done => {
    fs.rmSync(dist, { recursive: true, force: true });
    done();
});

task('inline', done => {
    const html = fs.readFileSync(path.join(dist, 'index.html')).toString();
    fs.writeFileSync(path.join(dist, 'inline.html'), inlineHtml(html));
    done();
});

task(
    'default',
    series('inline', done => {
        const html = fs.readFileSync(path.join(dist, 'inline.html'));
        const gz = zlib.gzipSync(html, { level: zlib.constants.Z_BEST_COMPRESSION });
        fs.writeFileSync(path.join(__dirname, '../src/html.h'), genHeader(html.length, gz, gz.length));
        done();
    }),
);
