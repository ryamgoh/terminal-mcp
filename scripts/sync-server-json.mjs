// Runs from `npm version <patch|minor|major>` (the "version" lifecycle script): copies the new package.json
// version into server.json, which the MCP Registry requires to match the published npm version.
import fs from 'node:fs';

const { version, name } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const server = JSON.parse(fs.readFileSync('server.json', 'utf8'));
server.version = version;
for (const p of server.packages) if (p.registryType === 'npm' && p.identifier === name) p.version = version;
fs.writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json -> ${version}`);
