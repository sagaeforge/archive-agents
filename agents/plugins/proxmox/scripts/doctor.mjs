// Turns the doctor's report into output and an exit code: 0 healthy, 1 warnings, 2 failures.
// doctor.sh is the way in. The checks are imported inside the try because a crash has to end in 2:
// Node's own exit code for one is 1, which would read as a mere warning.
const USAGE = `Usage: doctor.sh [--json]

Checks this machine's proxmox plugin and changes nothing.

  --json   Print the report as JSON

Exit codes: 0 healthy, 1 warnings, 2 failures.`;

function renderText({ checks, exitCode }) {
  const width = Math.max(...checks.map(({ title }) => title.length));
  const indent = " ".repeat(width + 12);
  const lines = checks.flatMap(({ id, title, status, summary, details = [], action }) => [
    `${String(id).padStart(2)}  ${status.padEnd(4)}  ${title.padEnd(width)}  ${summary}`,
    ...details.map((detail) => `${indent}${detail}`),
    ...(action ? [`${indent}-> ${action}`] : []),
  ]);
  const count = (status) => checks.filter((check) => check.status === status).length;
  const tally = ["pass", "warn", "fail", "skip"].map((status) => `${count(status)} ${status}`).join(", ");
  return [...lines, "", `${tally}. Exit code ${exitCode}.`].join("\n");
}

const args = process.argv.slice(2);

try {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
  } else if (args.some((arg) => arg !== "--json")) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const { runDoctor } = await import("./doctor-checks.mjs");
    const report = await runDoctor();
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderText(report));
    process.exitCode = report.exitCode;
  }
} catch (err) {
  console.error(`doctor: ${err.message}`);
  process.exitCode = 2;
}
