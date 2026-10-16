import unittest
from unittest.mock import Mock
from busybar_service import cloud_adapter
from busybar_notifier.model import Notification
from busybar_shared.cloud import CloudError

class CloudRoutingTest(unittest.TestCase):
    def test_generic_notifier_routes_by_registered_service_id_not_app_restrictions(self):
        github,datadog=Mock(),Mock()
        router=cloud_adapter.RoutedCloudQueue({'service-one':github,'service-two':datadog},
                                             {'github-comments':'service-one','github-ci':'service-one','datadog-alerts':'service-two'})
        comment=Notification('comment','info','anything-local','GH','NEW','detail',source='github-comments')
        ci=Notification('ci','attention','custom-label','GH','FAIL','detail',source='github-ci')
        alert=Notification('alert','urgent','datadog','DD','ALERT','detail',source='datadog-alerts')
        router.push([comment,ci]);router.set_state('datadog-alerts',[alert])
        self.assertEqual(github.push.call_args_list[0].args[0],[comment])
        self.assertEqual(github.push.call_args_list[1].args[0],[ci])
        datadog.set_state.assert_called_once_with('datadog-alerts',[alert])
        github.set_state.assert_not_called();datadog.push.assert_not_called()
        router.source_ok('github-ci',60);github.source_ok.assert_called_once_with('github-ci',60)
        router.source_error('datadog-alerts',RuntimeError('synthetic'));datadog.source_error.assert_called_once()

    def test_missing_route_does_not_fall_back_to_a_generic_notifier(self):
        queue=Mock();router=cloud_adapter.RoutedCloudQueue({'known':queue},{'source':'known'})
        item=Notification('one','info','github','GH','NEW','detail',source='not-registered')
        with self.assertRaisesRegex(CloudError,'service_registration_required'):router.push([item])
        queue.push.assert_not_called()
        with self.assertRaisesRegex(CloudError,'service_registration_required'):cloud_adapter.RoutedCloudQueue({'known':queue},{'source':'foreign'})

    def test_confirmed_admission_goes_back_to_the_correct_source_callback(self):
        queue=Mock();router=cloud_adapter.RoutedCloudQueue({'known':queue},{'github':'known'})
        shown=Mock();router.on_shown=shown
        item=Notification('one','info','github','GH','NEW','detail',source='github')
        queue.on_shown(item);shown.assert_called_once_with(item)

    def test_runtime_rejects_missing_same_or_wrong_template_agent_notifier(self):
        from types import SimpleNamespace
        from pathlib import Path
        import tempfile
        from unittest.mock import patch
        from busybar_service import cloud_watch
        for target,template in ((None,'notifier'),('status','notifier'),('other','agent')):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                agent=Mock();agent.config={'serviceId':'status','template':'agent','computerId':'pc'}
                other=Mock();other.config={'serviceId':'other','template':template,'computerId':'pc'}
                with patch.object(cloud_watch,'producers',return_value={'agent':agent,'other':other}), \
                     patch.object(cloud_watch,'load_computer',return_value={'routes':{'agent-notifier':target}}):
                    with self.assertRaisesRegex(CloudError,'setup_required_agent_notifier'):
                        cloud_watch.watch(SimpleNamespace(reduced_motion=True),Path(directory),Path(directory))
