# Legal boundary and clean-room statement

## What this project is

An independent, MIT-licensed implementation of **publicly documented protocols** used by download managers:

- HTTP range requests and resumption — RFC 9110 §14 (`Range`, `Content-Range`, `If-Range`, `ETag`), RFC 9111 (validators)
- Filename transport — RFC 6266, RFC 5987
- HTTP Live Streaming — RFC 8216
- MPEG-DASH — ISO/IEC 23009-1
- Model Context Protocol — the public MCP specification (JSON-RPC 2.0 over stdio)

## What this project is not

- It is **not** a copy, fork, decompilation, patch or repackaging of any commercial product.
- It does **not** contain code, resources, strings, fonts, icons, layouts or assets from any APK.
- It does **not** reproduce any product's private server API, request signing, licensing check or update mechanism.
- It does **not** circumvent DRM, paywalls, authentication or access controls. Encrypted manifests are detected and refused.

## On the reference analysis

A reference APK (1DM+ 18.2) was examined **statically and only at the metadata level** — package name, version, declared permissions, component names and intent filters from the compiled `AndroidManifest.xml`. Facts at that level are the app's public, machine-readable description of itself, and they were used the way a specification is used: to enumerate the **feature surface** to be implemented independently.

No DEX bytecode was decompiled. No resource table was decoded. No asset was extracted. No network traffic of the product was captured.

The output of that analysis is preserved in [`PARITY.md`](PARITY.md) so the reasoning can be checked line by line.

## Trademarks

"Internet Download Manager", "IDM", "1DM+" and any other product names are trademarks of their respective owners. They appear here **descriptively only**, to identify the category of software and the feature set compared against. No affiliation, endorsement or sponsorship is claimed or implied.

## Content responsibility

This tool downloads bytes from URLs you give it. Whether you may download a given file is governed by that site's terms and by your local copyright law — not by this software. The engine refuses obvious misuse vectors (no DRM circumvention) but cannot audit intent.

## Licensing of this repository

MIT — see [`../LICENSE`](../LICENSE). No third-party source is vendored; the only external components at runtime are Node.js built-ins.
