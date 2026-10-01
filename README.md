# errand-mcp — review copy

A small scheduling assistant. it reads transport-request emails from one dedicated mailbox
(read-only) and books each trip onto a driver's Google Calendar.

This repository is a **review copy**, published so an IT team can read the
source in the browser. The program logic is identical to the working
repository. Customer-identifying details were removed from a few code
comments, the test data, and the example configuration, and the test images
are omitted.

**Start with [`docs/IT-REVIEW.md`](docs/IT-REVIEW.md)**: the security and
data-handling brief, covering network surface, permissions, where data
rests, and known limitations. Most of its claims can be checked directly
against `src/`.

## Verify it yourself

Requires Node.js 20 or newer.

```
npm ci
npm test        # 68 automated tests
npm run build   # strict TypeScript build
```

## License

None. This code is published for review only; no license to use, copy, or
modify it is granted.

Questions: Joshua Kammeraad, Liberty Coding LLC — joshua@libertycoding.net
