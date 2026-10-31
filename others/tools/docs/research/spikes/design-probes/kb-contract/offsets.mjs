// Check the contract's example offsets, measured in code points.
const snip = "…신규 진입 기준은 2027-02-01부터 8,000시간/365일…";
const cps = [...snip];
const show = (s, e) => cps.slice(s, e).join("");
console.log("4.8 highlight {1,3}   =", JSON.stringify(show(1, 3)));
console.log("4.8 highlight {21,26} =", JSON.stringify(show(21, 26)));
console.log("expected 8,000 at     =", cps.join("").indexOf("8,000"), "(utf16 and cp agree here, snippet is BMP-only)");
const exact = "/ultraplan Removed in v2.1.222";
console.log("4.5 exact length      =", [...exact].length, "contract end-start =", 1234 - 1204);
// Cursor sample from 4.12 and 4.4
for (const c of ["eyJzIjoxODM0MjJ9"]) console.log("4.12 cursor decodes to", Buffer.from(c, "base64url").toString());
const zlib = await import("node:zlib");
console.log("zlib.zstdDecompress   =", typeof zlib.zstdDecompress, "node", process.version);
console.log("encodeURIComponent    =", encodeURIComponent("e:feature/claude-code-hooks"));
