// Figure out owner/repo from the git remote.
import { runCapture } from './shell.mjs';

export async function getOriginRemote() {
  const res = await runCapture('git', ['remote', 'get-url', 'origin']);
  if (res.code !== 0) {
    throw new Error('No `origin` remote configured on this repository.');
  }
  return res.stdout.trim();
}

export function parseGitHubRemote(url) {
  // Accepts https://github.com/<owner>/<repo>(.git) and git@github.com:<owner>/<repo>(.git)
  const httpsRe = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/;
  const sshRe = /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?\/?$/;
  const m = url.match(httpsRe) ?? url.match(sshRe);
  if (!m) throw new Error(`Could not parse GitHub owner/repo from: ${url}`);
  return { owner: m[1], repo: m[2] };
}

export async function getRepoSlug() {
  const url = await getOriginRemote();
  return parseGitHubRemote(url);
}

export function pagesUrl({ owner, repo }) {
  // Project pages live at https://<owner>.github.io/<repo>/ unless the repo
  // name is <owner>.github.io (user/org site), which serves at the root.
  if (repo.toLowerCase() === `${owner.toLowerCase()}.github.io`) {
    return `https://${owner}.github.io/`;
  }
  return `https://${owner}.github.io/${repo}/`;
}
