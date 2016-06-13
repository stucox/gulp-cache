'use strict';

var Cache = require('cache-swap');
var File = require('vinyl');
var objectAssign = require('object-assign');
var objectOmit = require('object.omit');
var objectPick = require('object.pick');
var PluginError = require('gulp-util').PluginError;
var TaskProxy = require('./lib/TaskProxy');
var Transform = require('readable-stream/transform');

var VERSION = require('./package.json').version;
var fileCache = new Cache({cacheDirName: 'gulp-cache'});

function fileToObj(file) {
  return objectPick(file, ['cwd', 'base', 'contents', 'stat', 'history', 'path']);
}

function restoreFileFromObj(obj) {
  if (obj.contents) {
    // Handle node 0.11 buffer to JSON as object with { type: 'buffer', data: [...] }
    if (Array.isArray(obj.contents.data)) {
      obj.contents = new Buffer(obj.contents.data);
    } else if (Array.isArray(obj.contents)) {
      obj.contents = new Buffer(obj.contents);
    } else if (typeof obj.contents === 'string') {
      obj.contents = new Buffer(obj.contents, 'base64');
    }
  }
  var restoredFile = new File(obj);
  var extraTaskProperties = objectOmit(obj, Object.keys(restoredFile));

  // Restore any properties that the original task put on the file;
  // but omit the normal properties of the file
  return objectAssign(restoredFile, extraTaskProperties);
}

var defaultOptions = {
  fileCache: fileCache,
  name: 'default',
  key: function defaultKey(fileOrFiles) {
    // fileOrFiles is an array of files if manyToMany=true, otherwise just 1 file
    var files = this.manyToMany ? fileOrFiles : [fileOrFiles];
    var filesContents = files.map(function(file) {
      return file.contents.toString('base64');
    }).join('');
    return [VERSION].concat(filesContents).join('');
  },
  manyToMany: false,
  restore: function(value) {
    return this.manyToMany ? value.map(restoreFileFromObj) : restoreFileFromObj(value);
  },
  success: true,
  value: function(fileOrFiles) {
    // Convert from a File object (from vinyl) into a plain object
    return this.manyToMany ? fileOrFiles.map(fileToObj) : fileToObj(fileOrFiles);
  }
};

var cacheTask = function(task, opts) {
  // Check for required task option
  if (!task) {
    throw new PluginError('gulp-cache', 'Must pass a task to cache()');
  }

  // Check if this task participates in the cacheable contract
  if (task.cacheable) {
    // Use the cacheable options, but allow the user to override them
    opts = objectAssign({}, task.cacheable, opts);
  }

  // Make sure we have some sane defaults
  opts = objectAssign({}, cacheTask.defaultOptions, opts);

  function processFiles(transform, files, cb) {
    new TaskProxy({
      task: task,
      files: files,
      opts: opts
    })
    .processFiles().then(function(outputFiles) {
      // Emit each file in the outputFiles array
      outputFiles.forEach(transform.push.bind(transform));
      cb(null);
    }, function(err) {
      cb(new PluginError('gulp-cache', err));
    });
  }

  var inputFiles = [];

  return new Transform({
    objectMode: true,
    // Called per input file:
    transform: function(file, enc, cb) {
      if (file.isNull()) {
        cb(null, file);
        return;
      }

      if (file.isStream()) {
        cb(new PluginError('gulp-cache', 'Cannot operate on stream sources'));
        return;
      }

      if (opts.manyToMany) {
        // Many-to-many mode: collect input files to process together
        inputFiles.push(file);
        cb();
      } else {
        // Single-file mode: process this file alone
        processFiles(this, [file], cb);
      }
    },
    // Called once all files have been recieved:
    flush: function(cb) {
      // In many-to-many mode, pass all input files together
      if (opts.manyToMany) {
        processFiles(this, inputFiles, cb);
      } else {
        cb();
      }
    }
  });
};

cacheTask.clear = function(opts) {
  opts = objectAssign({}, cacheTask.defaultOptions, opts);

  function removeFiles(transform, files, cb) {
    new TaskProxy({
      task: null,
      files: files,
      opts: opts
    })
    .removeCachedResult().then(function() {
      // Backward compatibility: consumers may use .on('data')
      // to determine when task is complete
      transform.push(files[0]);
      cb();
    }).catch(function(err) {
      cb(new PluginError('gulp-cache', err));
    });
  }

  var inputFiles = [];

  return new Transform({
    objectMode: true,
    // Called per input file:
    transform: function(file, enc, cb) {
      if (file.isNull()) {
        cb(null, file);
        return;
      }

      if (file.isStream()) {
        cb(new PluginError('gulp-cache', 'Cannot operate on stream sources'));
        return;
      }

      if (opts.manyToMany) {
        // Many-to-many mode: collect input files to process together
        inputFiles.push(file);
        cb();
      } else {
        // Single-file mode: process this file alone
        removeFiles(this, [file], cb);
      }
    },
    // Called once all files have been recieved:
    flush: function(cb) {
      // In many-to-many mode, pass all input files together
      if (opts.manyToMany) {
        removeFiles(this, inputFiles, cb);
      } else {
        cb();
      }
    }
  });
};

cacheTask.clearAll = function(done) {
  fileCache.clear(null, function(err) {
    if (err) {
      var pluginError = new PluginError(
        'gulp-cache',
        'Problem clearing the cache: ' + err.message
      );

      if (done) {
        done(pluginError);
        return;
      }

      throw pluginError;
    }

    if (done) {
      done();
    }
  });
};

cacheTask.fileCache = fileCache;
cacheTask.defaultOptions = defaultOptions;
cacheTask.Cache = Cache;

module.exports = cacheTask;
