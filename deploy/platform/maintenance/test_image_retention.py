import unittest

from image_retention import candidates, confirmed_manifest


API = 'ghcr.io/thevladbog/markiro-api@sha256:'
EDGE = 'ghcr.io/thevladbog/markiro-platform-edge@sha256:'
IDS = [f'sha256:{value * 64}' for value in 'abcdef']


class ImageRetentionTest(unittest.TestCase):
    def test_only_selects_old_recoverable_rollouts(self):
        history = [
            {IDS[0]: API + '1' * 64},
            {IDS[1]: API + '2' * 64},
            {IDS[2]: API + '3' * 64, IDS[3]: EDGE + '4' * 64},
            {IDS[4]: API + '5' * 64},
        ]
        usage = {IDS[3]}  # Includes stopped containers.
        present = {item: {'RepoTags': [], 'RepoDigests': []} for item in IDS}
        present[IDS[4]]['RepoTags'] = ['keep:operator']
        self.assertEqual(candidates(history, usage, present), {IDS[2]: API + '3' * 64})

    def test_refuses_extra_local_digest_and_reused_previous_image(self):
        history = [{IDS[0]: API + '1' * 64}, {IDS[1]: API + '2' * 64},
                   {IDS[1]: API + '2' * 64, IDS[2]: API + '3' * 64}]
        present = {IDS[1]: {}, IDS[2]: {'RepoDigests': [API + '9' * 64]}}
        self.assertEqual(candidates(history, set(), present), {})

    def test_missing_or_wrong_ghcr_manifest_does_not_authorize_removal(self):
        data = {'schemaVersion': 2, 'config': {'digest': IDS[2]}, 'layers': [{'digest': IDS[3]}]}
        self.assertTrue(confirmed_manifest(data, IDS[2]))
        self.assertFalse(confirmed_manifest(data, IDS[1]))
        self.assertFalse(confirmed_manifest({'manifests': [data]}, IDS[2]))
        self.assertFalse(confirmed_manifest({**data, 'layers': []}, IDS[2]))


if __name__ == '__main__':
    unittest.main()
