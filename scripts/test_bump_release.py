"""Release preparation regressions; no Git changes or Marketplace access."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('bump-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, self.original)
        Path('gradle.properties').write_text('pluginVersion = 0.3.0\njavaVersion = 17\n')
        self.notes = ('# Changelog\n\n## [Unreleased]\n\n{body}'
                      '## [0.3.0] — 2026-09-05\n\n### Added\n\n- Previous release.\n\n'
                      '[Unreleased]: https://github.com/Bigsy/redline/compare/v0.3.0...HEAD\n')

    def prepare(self, body='', tag_exists=False):
        Path('CHANGELOG.md').write_text(self.notes.format(body=body))
        with patch.object(release.subprocess, 'run', return_value=SimpleNamespace(returncode=0 if tag_exists else 1)):
            return release.prepare_release()

    def test_moves_notes_and_updates_links(self):
        self.assertEqual(self.prepare('### Fixed\n\n- Keep this fix.\n\n'), '0.3.1')
        notes = Path('CHANGELOG.md').read_text()
        self.assertIn('## [Unreleased]\n\n## [0.3.1]', notes)
        self.assertEqual(notes.count('- Keep this fix.'), 1)
        self.assertIn('- Previous release.', notes)
        self.assertIn('/compare/v0.3.0...v0.3.1', notes)
        self.assertIn('/compare/v0.3.1...HEAD', notes)
        self.assertEqual(Path('gradle.properties').read_text(), 'pluginVersion = 0.3.1\njavaVersion = 17\n')

    def test_empty_notes(self):
        self.prepare()
        self.assertIn('Maintenance release', Path('CHANGELOG.md').read_text())

    def test_existing_tag_leaves_files_unchanged(self):
        with self.assertRaisesRegex(SystemExit, 'already exists'):
            self.prepare(tag_exists=True)
        self.assertEqual(Path('gradle.properties').read_text(), 'pluginVersion = 0.3.0\njavaVersion = 17\n')
        self.assertEqual(Path('CHANGELOG.md').read_text(), self.notes.format(body=''))

    def test_invalid_changelog_leaves_version_unchanged(self):
        self.notes = '# No Unreleased section\n'
        with self.assertRaisesRegex(SystemExit, 'Expected an Unreleased'):
            self.prepare()
        self.assertIn('0.3.0', Path('gradle.properties').read_text())


if __name__ == '__main__':
    unittest.main()
