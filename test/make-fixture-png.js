/*
  A deterministic PNG, built by hand.

  The render test needs a capture whose every pixel is identifiable, so that a
  colour read back off the canvas proves exactly which source pixel was drawn
  there. Pixel (x, y) is rgb(x, y, 200) — the hex IS the coordinate.

  256px for the 128-point capture region means exactly 2 device pixels per
  point, which is a real Retina display rather than a ratio that could never
  occur. The scale is derived from the image at runtime, not assumed, so this
  also proves the derivation.

  Written out longhand rather than pulled from a library: the whole point of the
  render suite is that it depends on nothing but a browser.
*/

const zlib = require('zlib');

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

// pixel(x, y) must return [r, g, b].
function makePng(width, height, pixel) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;        // bit depth
    ihdr[9] = 2;        // colour type 2 = truecolour RGB
    ihdr[10] = 0;       // deflate
    ihdr[11] = 0;       // adaptive filtering
    ihdr[12] = 0;       // no interlace

    const raw = Buffer.alloc(height * (1 + width * 3));
    let at = 0;
    for (let y = 0; y < height; y++) {
        raw[at++] = 0;  // filter type 0 for the scanline
        for (let x = 0; x < width; x++) {
            const rgb = pixel(x, y);
            raw[at++] = rgb[0];
            raw[at++] = rgb[1];
            raw[at++] = rgb[2];
        }
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// The loupe fixture: a 128-point region captured on a 2x display.
const FIXTURE_PX = 256;
const FIXTURE_POINTS = 128;

function loupeFixture() {
    return makePng(FIXTURE_PX, FIXTURE_PX, (x, y) => [x, y, 200]).toString('base64');
}

function expectedHex(x, y) {
    const two = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    return '#' + two(x) + two(y) + two(200);
}

module.exports = { makePng, loupeFixture, expectedHex, FIXTURE_PX, FIXTURE_POINTS };
