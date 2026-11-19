# Third-party notices

`index.js` is a prebuilt bundle so the plugin installs without a dependency
install step (a DSH profile links local bundles without installing their
`dependencies`). The bundle inlines code from these MIT-licensed packages.

## @mossai/mosslive 0.1.0

- Source: https://www.npmjs.com/package/@mossai/mosslive
- License: MIT (the package states that its SDK, adapter templates and browser
  demo are MIT; third-party dependencies keep their own licenses)
- Used for: the delegation bridge (`attachDelegation`), queueing, receipt
  acknowledgement and cancellation around MOSS-Live's realtime protocol.

## ws 8.21.3

- Source: https://github.com/websockets/ws
- License: MIT
- Used for: the upstream WebSocket client and the browser-facing
  `WebSocketServer` upgrade handling.

## Node.js

Node.js is a separately installed runtime and is not bundled.

The full MIT text that governs the packages above is reproduced below.

---

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
