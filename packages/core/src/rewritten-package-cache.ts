import { PackageCache, Package, getOrCreate } from '@embroider/shared-internals';
import { existsSync, readJSONSync } from 'fs-extra';
import { resolve } from 'path';
import { Memoize } from 'typescript-memoize';

export interface RewrittenPackageIndex {
  // keys are paths to original package root directories.
  //
  // values are paths to rewritten directories.
  //
  // all paths are interpreted relative to the rewritten package index file
  // itself.
  packages: Record<string, string>;

  // key is path to the rewritten package that needs to resolve an extra
  // dependency
  //
  // value is list of paths to packages that it should be able to resolve.
  //
  // while the key is always one of our rewritten packages, the values can be
  // rewritten ones or not.
  extraResolutions: Record<string, string[]>;
}

// without this, using a class as an interface forces you to have the same
// private and protected methods too (since people trying to extend from you
// could see all of those)
type PublicAPI<T> = { [K in keyof T]: T[K] };

// TODO: as our refactor lands we should be able to remove these things from
// PackageCache itself.
type PackageCacheTheGoodParts = Omit<PublicAPI<PackageCache>, 'basedir' | 'seed' | 'shareAs'>;

export class RewrittenPackageCache implements PackageCacheTheGoodParts {
  constructor(private plainCache: PackageCache) {}

  get appRoot(): string {
    return this.plainCache.appRoot;
  }

  resolve(packageName: string, fromPackage: Package): Package {
    let oldRoot = this.index.newToOld.get(fromPackage.root);
    if (!oldRoot) {
      // the fromPackage has not been moved, so we're just providing the plain
      // behavior.
      return this.plainCache.resolve(packageName, fromPackage);
    }

    // check for any extraResolutions
    let extraResolutions = this.index.extraResolutions.get(fromPackage.root);
    if (extraResolutions) {
      for (let depRoot of extraResolutions) {
        let depPkg = this.plainCache.get(depRoot);
        if (depPkg.name === packageName) {
          return this.maybeMoved(depPkg);
        }
      }
    }

    // do the real resolving from the old location
    let oldSrc = this.plainCache.get(oldRoot);
    let oldDest = this.plainCache.resolve(packageName, oldSrc);

    // and if the package we found was itself moved return the moved one.
    return this.maybeMoved(oldDest);
  }

  // ensure we have the moved version of the package
  private maybeMoved(pkg: Package): Package {
    let newRoot = this.index.oldToNew.get(pkg.root);
    if (newRoot) {
      return this.get(newRoot);
    } else {
      return pkg;
    }
  }

  get(packageRoot: string): Package {
    return this.maybeWrap(this.plainCache.get(packageRoot));
  }

  original(pkg: Package): Package | undefined {
    let oldRoot = this.index.newToOld.get(pkg.root);
    if (oldRoot) {
      return this.plainCache.get(oldRoot);
    }
  }

  ownerOfFile(filename: string): Package | undefined {
    let owner = this.plainCache.ownerOfFile(filename);
    if (owner) {
      return this.maybeWrap(owner);
    }
  }

  @Memoize()
  private get index(): {
    oldToNew: Map<string, string>;
    newToOld: Map<string, string>;
    extraResolutions: Map<string, string[]>;
  } {
    let addonsDir = resolve(this.appRoot, 'node_modules', '.embroider', 'rewritten-packages');
    let indexFile = resolve(addonsDir, 'index.json');
    if (existsSync(indexFile)) {
      // I should probably make the else case throw here soon.
      let { packages, extraResolutions } = readJSONSync(indexFile) as RewrittenPackageIndex;
      return {
        oldToNew: new Map(
          Object.entries(packages).map(([oldRoot, newRoot]) => [
            resolve(addonsDir, oldRoot),
            resolve(addonsDir, newRoot),
          ])
        ),
        newToOld: new Map(
          Object.entries(packages).map(([oldRoot, newRoot]) => [
            resolve(addonsDir, newRoot),
            resolve(addonsDir, oldRoot),
          ])
        ),
        extraResolutions: new Map(
          Object.entries(extraResolutions).map(([fromRoot, toRoots]) => [
            resolve(addonsDir, fromRoot),
            toRoots.map(r => resolve(addonsDir, r)),
          ])
        ),
      };
    }
    return { oldToNew: new Map(), newToOld: new Map(), extraResolutions: new Map() };
  }

  // put a WrappedPackage around Packages that do in fact represent ones that we
  // have moved, leaving other Packages alone.
  private maybeWrap(pkg: Package) {
    let oldRoot = this.index.newToOld.get(pkg.root);
    if (oldRoot) {
      let found = wrapped.get(pkg);
      if (!found) {
        found = new MovedPackage(this, pkg);
        wrapped.set(pkg, found);
      }
      return castToPackage(found);
    } else {
      return pkg;
    }
  }
  static shared(identifier: string, appRoot: string) {
    let pk = getOrCreate(
      shared,
      identifier + appRoot,
      () => new RewrittenPackageCache(PackageCache.shared(identifier, appRoot))
    );
    if (pk.appRoot !== appRoot) {
      throw new Error(`bug: PackageCache appRoot disagreement ${appRoot}!=${pk.appRoot}`);
    }
    return pk;
  }
}

const shared: Map<string, RewrittenPackageCache> = new Map();
const wrapped = new WeakMap<Package, MovedPackage>();

// TODO: as our refactor lands we should be able to remove this from Package
// itself.
type PackageTheGoodParts = Omit<PublicAPI<Package>, 'nonResolvableDeps'>;

// TODO: this goes with the above TODO and can get deleted when it does.
function castToPackage(m: MovedPackage): Package {
  return m as unknown as Package;
}

class MovedPackage implements PackageTheGoodParts {
  // plainPkg is not the Package in the original un-moved location, it's the
  // plain representation of the moved location. That is, when you grab
  // plainPkg.root it will show the new location, and plainPkg.packageJSON shows
  // the rewritten package.json contained there.
  //
  // The point of MovedPackage is to finesse the parts of plainPkg that wouldn't
  // be correct if you used them directly. For example, plainPkg.dependencies
  // won't necessarily even work, because if you try to resolve them from the
  // moved location they might not be there.
  constructor(private packageCache: RewrittenPackageCache, private plainPkg: Package) {}

  get root() {
    return this.plainPkg.root;
  }

  get name() {
    return this.plainPkg.name;
  }

  get version() {
    return this.plainPkg.version;
  }

  get packageJSON() {
    return this.plainPkg.packageJSON;
  }

  get meta() {
    return this.plainPkg.meta;
  }

  get isEmberPackage() {
    return this.plainPkg.isEmberPackage;
  }

  get isEngine() {
    return this.plainPkg.isEngine;
  }

  get isLazyEngine() {
    return this.plainPkg.isLazyEngine;
  }

  get isV2Ember() {
    return this.plainPkg.isV2Ember;
  }

  get isV2App() {
    return this.plainPkg.isV2App;
  }

  get isV2Addon() {
    return this.plainPkg.isV2Addon;
  }

  // it's important that we're calling this.dependencies here at this level, not
  // plainPkg.dependencies, which wouldn't be correct
  findDescendants(filter?: (pkg: Package) => boolean): Package[] {
    let pkgs = new Set<Package>();
    let queue: Package[] = [castToPackage(this)];
    while (true) {
      let pkg = queue.shift();
      if (!pkg) {
        break;
      }
      if (!pkgs.has(pkg)) {
        pkgs.add(pkg);
        let nextLevel;
        if (filter) {
          nextLevel = pkg.dependencies.filter(filter);
        } else {
          nextLevel = pkg.dependencies;
        }
        nextLevel.forEach(d => queue.push(d));
      }
    }
    pkgs.delete(castToPackage(this));
    return [...pkgs.values()];
  }

  get mayRebuild() {
    return this.plainPkg.mayRebuild;
  }

  get dependencyNames() {
    return this.plainPkg.dependencyNames;
  }

  get dependencies() {
    return this.plainPkg.dependencyNames
      .map(name => {
        try {
          return this.packageCache.resolve(name, castToPackage(this));
        } catch (error) {
          // if the package was not found do not error out here. this is relevant
          // for the case where a package might be an optional peerDependency and we dont
          // want to error if it was not found. Additionally, erroring here is "far" away
          // from the actual logical failure point and so not failing here will provide a better
          // error message down the line
          if (error.code === 'MODULE_NOT_FOUND') {
            return false;
          }

          throw error;
        }
      })
      .filter(Boolean) as Package[];
  }

  hasDependency(name: string): boolean {
    // this is *not* extended because it's understood that the rewritten package
    // should explictly list the things that need extraResolutions in its own
    // package.json.ß
    return this.plainPkg.hasDependency(name);
  }
}