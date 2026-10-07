// Drive a built tool handler without an MCP client, for rehearsal and
// debugging:  node scripts/drive.mjs <email|calendar|fetch_handle> '<json args>'
// Args are the tool's schema minus nothing -- instance and mode included.

const [, , tool, rawArgs] = process.argv;
if (!tool || !rawArgs) {
  console.error(`usage: node scripts/drive.mjs <email|calendar|fetch_handle> '<json args>'`);
  process.exit(1);
}

const mods = {
  email: ["../dist/tools/email.js", "handleEmail"],
  calendar: ["../dist/tools/calendar.js", "handleCalendar"],
  fetch_handle: ["../dist/tools/handles.js", "handleFetchHandle"],
};
const entry = mods[tool];
if (!entry) {
  console.error(`unknown tool "${tool}"`);
  process.exit(1);
}

const mod = await import(entry[0]);
const result = await mod[entry[1]](JSON.parse(rawArgs));
for (const block of result.content) {
  if (block.type === "text") console.log(block.text);
  else console.log(`[${block.type} block, ${(block.data ?? "").length} b64 chars, ${block.mimeType ?? ""}]`);
}
if (result.isError) process.exitCode = 1;
