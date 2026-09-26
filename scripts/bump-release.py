"""Prepare the next patch release from CHANGELOG.md; run at the repository root."""
import datetime
import re
import subprocess
from pathlib import Path


def prepare_release():
    properties = Path('gradle.properties')
    changelog = Path('CHANGELOG.md')
    text = properties.read_text()
    notes = changelog.read_text()
    match = re.search(r'^pluginVersion[ \t]*=[ \t]*(\d+)\.(\d+)\.(\d+)[ \t]*$', text, re.M)
    if not match:
        raise SystemExit('pluginVersion must be a numeric major.minor.patch version')
    major, minor, patch = map(int, match.groups())
    old = f'{major}.{minor}.{patch}'
    version = f'{major}.{minor}.{patch + 1}'
    if subprocess.run(['git', 'rev-parse', '--verify', '--quiet', f'refs/tags/v{version}'],
                      stdout=subprocess.DEVNULL, check=False).returncode == 0:
        raise SystemExit(f'Tag v{version} already exists')
    section = re.search(r'^## \[Unreleased\][ \t]*\n(.*?)(?=^## \[|\Z)', notes, re.M | re.S)
    link = re.search(r'^\[Unreleased\]: https://github.com/Bigsy/redline/compare/v' +
                     re.escape(old) + r'\.\.\.HEAD$', notes, re.M)
    if not section or not link:
        raise SystemExit('Expected an Unreleased section and compare link for the current version')
    if re.search(r'^## \[' + re.escape(version) + r'\]', notes, re.M):
        raise SystemExit(f'CHANGELOG.md already contains [{version}]')
    body = section[1].strip() or '### Changed\n\n- Maintenance release with the latest fixes and improvements.'
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    # Replace the link first, so the section offsets remain valid.
    notes = notes[:link.start()] + (
        f'[Unreleased]: https://github.com/Bigsy/redline/compare/v{version}...HEAD\n'
        f'[{version}]: https://github.com/Bigsy/redline/compare/v{old}...v{version}'
    ) + notes[link.end():]
    notes = notes[:section.start()] + (
        f'## [Unreleased]\n\n## [{version}] — {today}\n\n{body}\n\n'
    ) + notes[section.end():]
    properties.write_text(text[:match.start()] + f'pluginVersion = {version}' + text[match.end():])
    changelog.write_text(notes)
    return version


if __name__ == '__main__':
    print(prepare_release())
