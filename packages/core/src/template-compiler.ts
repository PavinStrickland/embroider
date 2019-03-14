import stripBom from 'strip-bom';
import { Resolution, Resolver, ResolverParams } from './resolver';
import { warn } from './messages';
import { readFileSync } from 'fs';
import { makeResolverTransform } from './resolver-transform';
import { Tree } from 'broccoli-plugin';
import Filter from 'broccoli-persistent-filter';
import stringify from 'json-stable-stringify';
import { createHash } from 'crypto';

import { join } from 'path';
import { PluginItem } from '@babel/core';

export interface Plugins {
  ast?: unknown[];
}

interface AST {
  _deliberatelyOpaque: 'AST';
}

interface PreprocessOptions {
  contents: string;
  moduleName: string;
  plugins?: Plugins;
}

// This just reflects the API we're extracting from ember-template-compiler.js,
// plus a cache key that lets us know when the underlying source has remained
// stable.
interface GlimmerSyntax {
  preprocess(html: string, options?: PreprocessOptions): AST;
  print(ast: AST): string;
  defaultOptions(options: PreprocessOptions): PreprocessOptions;
  registerPlugin(type: string, plugin: unknown): void;
  precompile(templateContents: string, options: { contents: string, moduleName: string }): string;
  _Ember: { FEATURES: any, ENV: any };
  cacheKey: string;
}

// we could directly depend on @glimmer/syntax and have nice types and
// everything. But the problem is, we really want to use the exact version that
// the app itself is using, and its copy is bundled away inside
// ember-template-compiler.js.
function loadGlimmerSyntax(templateCompilerPath: string): GlimmerSyntax {
  let orig = Object.create;
  let grabbed: any[] = [];
  let source = readFileSync(templateCompilerPath, 'utf8');

  // we need this in scope here so our eval below will use it (instead of our
  // own module scoped one)
  let module = { exports: {} };

  (Object as any).create = function(proto: any, propertiesObject: any) {
    let result = orig.call(this, proto, propertiesObject);
    grabbed.push(result);
    return result;
  };
  try {
    // eval evades the require cache, which we need because the template
    // compiler shares internal module scoped state.
    eval(source);
  } finally {
    Object.create = orig;
  }
  for (let obj of grabbed) {
    if (obj['@glimmer/syntax'] && obj['@glimmer/syntax'].print) {
      // we found the loaded modules
      return {
        print: obj['@glimmer/syntax'].print,
        preprocess: obj['@glimmer/syntax'].preprocess,
        defaultOptions: obj['ember-template-compiler/lib/system/compile-options'].default,
        registerPlugin: obj['ember-template-compiler/lib/system/compile-options'].registerPlugin,
        precompile: (module.exports as any).precompile,
        _Ember: (module.exports as any)._Ember,
        cacheKey: createHash('md5').update(source).digest('hex'),
      };
    }
  }
  throw new Error(`unable to find @glimmer/syntax methods in ${templateCompilerPath}`);
}

export interface SetupCompilerParams {
  compilerPath: string;
  resolverPath?: string;
  resolverParams?: ResolverParams;
  EmberENV: unknown;
  plugins: Plugins;
}

// The signature of this function may feel a little weird, but that's because
// it's designed to be easy to invoke via our portable plugin config in a new
// process.
export default class TemplateCompiler {
  private dependencies:  Map<string, Resolution[]> = new Map();
  private syntax: GlimmerSyntax;
  private userPluginsCount = 0;
  readonly cacheKey: string;

  constructor(params: SetupCompilerParams) {
    this.syntax = loadGlimmerSyntax(params.compilerPath);
    this.registerPlugins(params.plugins);
    let cacheKeyInput: any = { syntax: this.syntax.cacheKey };
    if (params.resolverPath && params.resolverParams) {
      let resolverPath = require.resolve(params.resolverPath);
      let ResolverClass: Resolver = require(resolverPath).default;
      let resolver = new ResolverClass(params.resolverParams);
      this.syntax.registerPlugin('ast', makeResolverTransform(resolver, this.dependencies));
      this.userPluginsCount++;
      cacheKeyInput['resolverParams'] = params.resolverParams;
      cacheKeyInput['resolverSource'] = readFileSync(resolverPath, 'utf8');
    }
    this.initializeEmberENV(params.EmberENV);
    this.cacheKey = createHash('md5').update(stringify(cacheKeyInput)).digest('hex');
  }

  // This is only public to make testing easier. During normal usage it's not
  // called from outside.
  dependenciesOf(moduleName: string): Resolution[] | undefined {
    return this.dependencies.get(moduleName);
  }

  // Compiles all the way from a template string to a javascript module string.
  compile(moduleName: string, contents: string) {
    let compiled = this.syntax.precompile(
      stripBom(contents), {
        contents,
        moduleName
      }
    );
    let lines: string[] = [];
    let deps = this.dependenciesOf(moduleName);
    if (deps) {
      let counter = 0;
      for (let dep of deps) {
        if (dep.type === 'error') {
          if (dep.hardFail) {
            throw new Error(dep.message);
          } else {
            warn(dep.message);
          }
        } else {
          for (let { runtimeName, path } of dep.modules) {
            lines.push(`import a${counter} from "${path}";`);
            lines.push(`window.define('${runtimeName}', function(){ return a${counter++}});`);
          }
        }
      }
    }
    lines.push(`export default Ember.HTMLBars.template(${compiled});`);
    return lines.join("\n");
  }

  // Applies all custom AST transforms and emits the results still as
  // handlebars.
  applyTransforms(moduleName: string, contents: string) {
    let opts = this.syntax.defaultOptions({ contents, moduleName });
    if (opts.plugins && opts.plugins.ast) {
      // the user-provided plugins come first in the list, and those are the
      // only ones we want to run. The built-in plugins don't need to run here
      // in stage1, it's better that they run in stage3 when the appropriate
      // ember version is in charge.
      //
      // rather than slicing them off, we could choose instead to not call
      // syntax.defaultOptions, but then we lose some of the compatibility
      // normalization that it does on the user-provided plugins.
      opts.plugins.ast = opts.plugins.ast.slice(0, this.userPluginsCount);
    }
    let ast = this.syntax.preprocess(contents, opts);
    return this.syntax.print(ast);
  }

  // Use applyTransforms on every file in a broccoli tree.
  applyTransformsToTree(tree: Tree): Tree {
    return new TemplateCompileTree(tree, this, 1);
  }

  // Use applyTransforms on the contents of inline hbs template strings inside
  // Javascript.
  inlineTransformsBabelPlugin(): PluginItem {
    // TODO: add parallelBabel protocol
    return [join(__dirname, 'babel-plugin-inline-hbs.js'), { templateCompiler: this }];
  }

  private registerPlugins(plugins: Plugins) {
    if (plugins.ast) {
      for (let i = 0, l = plugins.ast.length; i < l; i++) {
        this.syntax.registerPlugin('ast', plugins.ast[i]);
        this.userPluginsCount++;
      }
    }
  }

  private initializeEmberENV(EmberENV: any) {
    if (!EmberENV) { return; }

    let props;

    if (EmberENV.FEATURES) {
      props = Object.keys(EmberENV.FEATURES);
      props.forEach(prop => {
        this.syntax._Ember.FEATURES[prop] = EmberENV.FEATURES[prop];
      });
    }

    if (EmberENV) {
      props = Object.keys(EmberENV);
      props.forEach(prop => {
        if (prop === 'FEATURES') { return; }
        this.syntax._Ember.ENV[prop] = EmberENV[prop];
      });
    }
  }

  baseDir() {
    return join(__dirname, '..');
  }
}

class TemplateCompileTree extends Filter {
  constructor(inputTree: Tree, private templateCompiler: TemplateCompiler, private stage: 1 | 3) {
    super(inputTree, {
      name: `embroider-template-compile-stage${stage}`,
      persist: true,
      extensions: ['hbs', 'handlebars'],
      // in stage3 we are changing the file extensions from hbs to js. In
      // stage1, we are just keeping hbs.
      targetExtension: stage === 3 ? 'js' : undefined
    });
  }

  processString(source: string, relativePath: string) {
    if (this.stage === 1) {
      return this.templateCompiler.applyTransforms(relativePath, source);
    } else {
      return this.templateCompiler.compile(relativePath, source);
    }
  }
  cacheKeyProcessString(source: string, relativePath: string) {
    return `${this.stage}-${this.templateCompiler.cacheKey}` + super.cacheKeyProcessString(source, relativePath);
  }
  baseDir() {
    return join(__dirname, '..');
  }
}
