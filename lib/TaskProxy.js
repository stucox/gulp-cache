'use strict';

var crypto = require('crypto');

var objectAssign = require('object-assign');
var objectOmit = require('object.omit');
var Bluebird = require('bluebird');
var tryJsonParse = require('try-json-parse');

var TaskProxy = function(opts) {
  objectAssign(this, {
    task: opts.task,
    files: opts.files,
    opts: opts.opts,
    originalPaths: opts.files.map(function(f) {
      return f.path;
    })
  });
};

function makeHash(key) {
  return crypto.createHash('md5').update(key).digest('hex');
}

objectAssign(TaskProxy.prototype, {
  processFiles: function() {
    var self = this;

    return this._checkForCachedValue().then(function(cached) {
      // If we found a cached value
      // The path of the cache key should also be identical to the original one when the file path changed inside the task
      if (cached.value) {
        if (self.opts.manyToMany) {
          return cached.value;
        } else if (!cached.value.filePathChangedInsideTask || cached.value.originalPath === self.files[0].path) {
          // Extend the cached value onto the file, but don't overwrite original path info
          var file = objectAssign(
            self.files[0],
            objectOmit(cached.value, ['cwd', 'path', 'base', 'stat', 'history'])
          );
          // Restore the file path if it was set
          if (cached.value.path && cached.value.filePathChangedInsideTask) {
            file.path = cached.value.path;
          }
          return [file];
        }
      }

      // Otherwise, run the proxied task
      return self._runProxiedTaskAndCache(cached.key);
    });
  },

  removeCachedResult: function() {
    var self = this;

    return this._getFileKey().then(function(cachedKey) {
      var removeCached = Bluebird.promisify(self.opts.fileCache.removeCached, {
        context: self.opts.fileCache
      });

      return removeCached(self.opts.name, cachedKey);
    });
  },

  _getFileKey: function() {
    var getKey = this.opts.key;

    if (typeof getKey === 'function' && getKey.length === 2) {
      getKey = Bluebird.promisify(getKey.bind(this.opts));
    }

    var keyVal = getKey.call(this.opts, this.opts.manyToMany ? this.files : this.files[0]);

    // getKey() may return a promise
    return Bluebird.resolve(keyVal).then(function(key) {
      if (!key) {
        return key;
      }

      return makeHash(key);
    });
  },

  _checkForCachedValue: function() {
    var self = this;

    return this._getFileKey().then(function(key) {
      // If no key returned, bug out early
      if (!key) {
        return {
          key: key,
          value: null
        };
      }

      var getCached = Bluebird.promisify(self.opts.fileCache.getCached.bind(self.opts.fileCache));

      return getCached(self.opts.name, key).then(function(cached) {
        if (!cached) {
          return {
            key: key,
            value: null
          };
        }

        var parsedContents = tryJsonParse(cached.contents);
        if (parsedContents === undefined) {
          parsedContents = {cached: cached.contents};
        }

        if (self.opts.restore) {
          parsedContents = self.opts.restore(parsedContents);
        }

        return {
          key: key,
          value: parsedContents
        };
      });
    });
  },

  _runProxiedTaskAndCache: function(cachedKey) {
    var self = this;

    return self._runProxiedTask().then(function(outputFiles) {
      // If this wasn't a success, continue to next task
      // TODO: Should this also offer an async option?
      if (self.opts.success !== true &&
          !self.opts.success(self.opts.manyToMany ? outputFiles : outputFiles[0])) {
        return outputFiles;
      }

      return self._storeCachedResult(cachedKey, outputFiles).then(function() {
        return outputFiles;
      });
    });
  },

  _runProxiedTask: function() {
    var self = this;

    return new Bluebird(function(resolve, reject) {
      // Collect all the files spat out by the proxied task
      var outputFiles = [];
      var handleError;
      var handleData;
      var handleEnd;

      handleError = function(err) {
        // TODO: Errors will step on each other here

        // Be good citizens and remove our listeners
        self.task.removeListener('error', handleError);
        self.task.removeListener('data', handleData);
        self.task.removeListener('end', handleEnd);

        // Reduce the maxListeners back down
        self.task.setMaxListeners(self.task._maxListeners - 3);

        reject(err);
      };

      handleData = function(file) {
        if (file) {
          outputFiles.push(file);

          if (!self.opts.manyToMany) {
            handleEnd();
          }
        }
      };

      handleEnd = function(file) {
        if (file) {
          outputFiles.push(file);
        }

        // Be good citizens and remove our listeners
        self.task.removeListener('error', handleError);
        self.task.removeListener('data', handleData);
        self.task.removeListener('end', handleEnd);

        // Reduce the maxListeners back down
        self.task.setMaxListeners(self.task._maxListeners - 3);

        resolve(outputFiles);
      };

      // Bump up max listeners to prevent memory leak warnings
      var currMaxListeners = self.task._maxListeners || 0;
      self.task.setMaxListeners(currMaxListeners + 3);

      self.task.on('data', handleData);
      self.task.once('error', handleError);
      self.task.once('end', handleEnd);

      // Run all files through the other task and grab output (or error)
      // Not sure if a _.defer is necessary here
      if (self.opts.manyToMany) {
        self.files.forEach(self.task.write.bind(self.task));
        self.task.end();
      } else {
        self.task.write(self.files[0]);
      }
    });
  },

  _getValueFromResult: function(outputFiles) {
    var self = this;
    var getValue;

    function pick(file) {
      var val = {};
      val[self.opts.value] = file[self.opts.value];
      return val;
    }

    if (typeof this.opts.value !== 'function') {
      if (typeof this.opts.value === 'string') {
        // e.g. `value: 'path'` to use _.pick(file, 'path')
        return this.opts.manyToMany ? Bluebird.resolve(outputFiles.map(pick)) :
                                      Bluebird.resolve(pick(outputFiles[0]));
      }

      return Bluebird.resolve(getValue);
    } else if (this.opts.value.length === 2) {
      // Promisify if passed a node style function
      getValue = Bluebird.promisify(this.opts.value.bind(this.opts));
    } else {
      getValue = this.opts.value;
    }

    return Bluebird.resolve(getValue.call(this.opts, this.opts.manyToMany ? outputFiles : outputFiles[0]));
  },

  _storeCachedResult: function(key, outputFiles) {
    var self = this;

    // If we didn't have a cachedKey, skip caching result
    if (!key) {
      return Bluebird.resolve(outputFiles);
    }

    return this._getValueFromResult(outputFiles).then(function(value) {
      var val;
      var addCached = Bluebird.promisify(self.opts.fileCache.addCached.bind(self.opts.fileCache));

      if (typeof value !== 'string') {
        if (value && typeof value === 'object' && Buffer.isBuffer(value.contents)) {
          // Shallow copy so "contents" can be safely modified
          val = objectAssign({}, value);
          val.contents = val.contents.toString('utf8');
        }

        // Check if the task changed the file path
        if (value.path !== self.originalPaths[0]) {
          value.filePathChangedInsideTask = true;
        }

        // Keep track of the original path
        value.originalPath = self.originalPaths[0];

        val = JSON.stringify(value, null, 2);
      } else {
        val = value;
      }

      return addCached(self.opts.name, key, val);
    });
  }
});

module.exports = TaskProxy;
