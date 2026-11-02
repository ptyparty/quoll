import os
import re
import shutil
import sys

import hero_sandbox as hs

ROOT = '/tmp/demo-notes'
SESSION = 'hero'
COLS, ROWS = 170, 48
ALT_O = '\x1bo'

PROMPT = (
    "Plan retries with backoff for the webhooks we send to partners. "
    "Put the plan in the notebook with a backoff table. Plan only, no code yet."
)
COMMENT = 'cap the delay at 1 hour, not longer'

KOMUX_CONFIG = '''export default {
  defaultCwd: %(project)s,
  env: {
    QUOLL_DIR: %(notebooks)s,
    QUOLL_COMMENT_COMMAND: "komux claude compose --from-stdin --label",
  },
  untrackedCommands: ["claude", "remax", "hx", "komux", "quoll"],
  tabs: { "checkout-service": { cwd: %(project)s, layout: "notes" } },
  startup: ["checkout-service"],
  layouts: {
    notes: {
      row: [
        { command: ["komux", "claude", "--mode", "auto"], name: "claude", focus: true },
        { command: ["quoll", "--focus=my-work"], name: "quoll" },
      ],
    },
  },
};
'''


def prepare(repo):
    shutil.rmtree(ROOT, ignore_errors=True)
    ptyparty = hs.ptyparty_dir(repo)
    sandbox, env = hs.environment(ROOT, ptyparty)
    project = hs.project_from_fixture(
        os.path.join(repo, 'scripts', 'hero-fixture', 'checkout-service'),
        os.path.join(ROOT, 'checkout-service'),
    )
    notebooks = os.path.join(ROOT, 'notebooks')
    os.makedirs(notebooks)
    hs.write_komux_config(env, KOMUX_CONFIG, project=project, notebooks=notebooks)
    hs.claude_config(sandbox, project, [os.path.join(repo, 'skills', 'quoll')], env, trim_watch=True)
    return project, env


def quoll_pane(text):
    return '\n'.join(line[COLS // 2:] for line in text.splitlines())


def table_hint(text):
    found = re.search(r'│ ([a-z]) ┌', quoll_pane(text))
    return found.group(1) if found else None


def tour(cast):
    cast.wait_for('Message Claude', budget=40)
    cast.hold(1.5)
    cast.keys(PROMPT, per_key=0.02)
    cast.hold(0.6)
    cast.press('\r', gap=1.0)
    cast.lapse_until(lambda t: '🚀 done' not in t, budget=20)
    if not cast.lapse_until(lambda t: '🚀 done' in t and '┌' in quoll_pane(t), budget=400):
        return False
    cast.hold(3)
    cast.press(ALT_O, gap=1.0)
    cast.keys('c', per_key=1.5)
    hint = table_hint(cast.text())
    if hint is None:
        return False
    cast.keys(hint, per_key=0.3)
    cast.wait_for('Message claude', budget=20, record=True)
    cast.hold(1.5)
    cast.keys(COMMENT, per_key=0.04)
    cast.hold(0.8)
    cast.press('\r', gap=1.0)
    cast.lapse_until(lambda t: '🚀 done' not in t, budget=30)
    if not cast.lapse_until(lambda t: '🚀 done' in t, budget=300):
        return False
    cast.hold(5)
    return True


def main():
    out_base = sys.argv[1]
    repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    project, env = prepare(repo)
    hs.record(['komux', 'attach', SESSION], COLS, ROWS, project, env, SESSION, tour, out_base)


if __name__ == '__main__':
    main()
