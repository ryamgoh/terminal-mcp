// Fills in your release identity in package.json, server.json, LICENSE and README.md. Pass any subset; run it
// again later for the rest (or to change a value). Usage:
//   node scripts/configure-release.mjs [--github-user <you>] [--repo terminal-mcp] [--npm-name <package>] [--author "<Your Name>"]
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const { 'github-user': user, 'npm-name': npmName, author } = args;
const repo = args.repo ?? 'terminal-mcp';
if (!user && !npmName && !author) {
  console.error('usage: node scripts/configure-release.mjs [--github-user <you>] [--repo <repo>] [--npm-name <package>] [--author "<Your Name>"]');
  process.exit(2);
}
if (npmName && !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(npmName)) {
  console.error(`"${npmName}" is not a valid npm package name`);
  process.exit(2);
}

const read = (f) => fs.readFileSync(f, 'utf8');
const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));
const previous = { name: pkg.name, mcpName: pkg.mcpName };
let readme = read('README.md');
let license = read('LICENSE');

if (user) {
  const mcpName = `io.github.${user}/${repo}`;
  const repoUrl = `https://github.com/${user}/${repo}`;
  Object.assign(pkg, {
    mcpName,
    repository: { type: 'git', url: `git+${repoUrl}.git` },
    homepage: `${repoUrl}#readme`,
    bugs: { url: `${repoUrl}/issues` },
  });
  server.name = mcpName;
  server.repository = { url: repoUrl, source: 'github' };
  readme = readme.replaceAll('io.github.YOUR_GITHUB_USER/YOUR_REPO', mcpName);
  if (previous.mcpName && !previous.mcpName.includes('YOUR_')) readme = readme.replaceAll(previous.mcpName, mcpName);
}
if (npmName) {
  pkg.name = npmName;
  for (const p of server.packages) if (p.registryType === 'npm') p.identifier = npmName;
  readme = readme.replaceAll('YOUR_NPM_PACKAGE', npmName);
  // A re-run with a new name replaces the old one too (the unconfigured default "terminal-mcp" is left alone).
  if (previous.name !== 'terminal-mcp' && previous.name !== npmName) readme = readme.replaceAll(previous.name, npmName);
}
if (author) {
  pkg.author = author;
  license = license.replace(/^Copyright \(c\) (\d{4}) .*$/m, `Copyright (c) $1 ${author}`);
}

fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
fs.writeFileSync('README.md', readme);
fs.writeFileSync('LICENSE', license);

const all = ['package.json', 'server.json', 'README.md', 'LICENSE'].map(read).join('\n');
const todo = [
  [/YOUR_GITHUB_USER|YOUR_REPO/, '--github-user'],
  [/YOUR_NPM_PACKAGE/, '--npm-name'],
  [/YOUR_NAME/, '--author'],
].filter(([re]) => re.test(all)).map(([, flag]) => flag);
console.log(`package.json: name "${pkg.name}", mcpName "${pkg.mcpName}", author "${pkg.author ?? ''}"`);
console.log(todo.length ? `still to set before publishing: ${todo.join(', ')}` : 'release identity complete');
