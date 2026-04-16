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
  // Accepts the four common remote shapes. The hostname can be a real
  // github.com or an SSH host alias from ~/.ssh/config (e.g.
  // `git@github-truffle:owner/repo`). We don't enforce the hostname
  // because the wizard talks to api.github.com via `gh` regardless —
  // the remote URL is just where we scrape owner/repo from.
  //
  //   https://[user@]<host>/<owner>/<repo>[.git][/]
  //   <user>@<host>:<owner>/<repo>[.git][/]          (SSH short form)
  //   ssh://<user>@<host>[:<port>]/<owner>/<repo>[.git][/]
  //   git://<host>/<owner>/<repo>[.git][/]
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
    /^[^@\s]+@[^:\s]+:([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
    /^ssh:\/\/[^/]+\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
    /^git:\/\/[^/]+\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return { owner: m[1], repo: m[2] };
  }
  throw new Error(`Could not parse owner/repo from: ${url}`);
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
