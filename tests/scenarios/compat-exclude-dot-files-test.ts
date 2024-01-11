import type { ExpectFile } from '@embroider/test-support/file-assertions/qunit';
import { expectRewrittenFilesAt } from '@embroider/test-support/file-assertions/qunit';
import { throwOnWarnings } from '@embroider/core';
import type { PreparedApp } from 'scenario-tester';
import { appScenarios, baseAddon } from './scenarios';
import QUnit from 'qunit';
import { merge } from 'lodash';
const { module: Qmodule, test } = QUnit;
import { setupAuditTest } from '@embroider/test-support/audit-assertions';

appScenarios
  .map('compat-exclude-dot-files', app => {
    merge(app.files, {
      app: {
        '.foobar.js': `// foobar content`,
        '.barbaz.js': `// barbaz content`,
        'bizbiz.js': `// bizbiz content`,
      },
    });

    let addon = baseAddon();
    addon.pkg.name = 'my-addon';
    merge(addon.files, {
      addon: {
        '.fooaddon.js': `// fooaddon content`,
        'baraddon.js': `// bizbiz content`,
      },
    });
    app.addDevDependency(addon);
  })
  .forEachScenario(function (scenario) {
    Qmodule(scenario.name, function (hooks) {
      throwOnWarnings(hooks);

      let app: PreparedApp;

      let expectFile: ExpectFile;

      hooks.before(async assert => {
        app = await scenario.prepare();
        let result = await app.execute('ember build', { env: { STAGE2_ONLY: 'true' } });
        assert.equal(result.exitCode, 0, result.output);
      });

      let expectAudit = setupAuditTest(hooks, () => ({ app: app.dir }));

      hooks.beforeEach(assert => {
        expectFile = expectRewrittenFilesAt(app.dir, { qunit: assert });
      });

      test('dot files are not included as app modules', function () {
        // dot files should exist on disk
        expectFile('./.foobar.js').exists();
        expectFile('./.barbaz.js').exists();
        expectFile('./bizbiz.js').exists();

        const embroiderAuditModules = expectAudit
          .module('./assets/app-template.js')
          .resolves('./-embroider-amd-modules.js')
          .toModule();

        embroiderAuditModules.withContents(contents => !contents.includes('app-template/.barbaz.js'));
        embroiderAuditModules.withContents(contents => !contents.includes('app-template/.foobar.js'));

        embroiderAuditModules
          .resolves('app-template/bizbiz.js')
          .to('./node_modules/.embroider/rewritten-app/bizbiz.js');
      });

      test('dot files are not included as addon implicit-modules', function () {
        // Dot files should exist on disk
        expectFile('./node_modules/my-addon/.fooaddon.js').exists();
        expectFile('./node_modules/my-addon/baraddon.js').exists();

        let myAddonPackage = expectFile('./node_modules/my-addon/package.json').json();

        // dot files are not included as implicit-modules
        myAddonPackage.get(['ember-addon', 'implicit-modules']).deepEquals(['./baraddon']);
      });
    });
  });
