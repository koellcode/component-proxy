var fs = require('fs-extra');
var request = require('superagent');
var path = require('path');
var _ = require('underscore');
var util = require('util');
var utils = require('./utils');
var temp = require('temp');
var Q = require('q');
var debug = require('debug')('proxy-install:raw-github-cache');


function RawGithubCache(cachePath, cache) {
  this._cachePath = cachePath;
  this._cache = cache;

  _.bindAll(this, 'middleware');
}

RawGithubCache.init = function(storageDir, cache) {
  var storagePath = utils.expandAndResolve(storageDir);
  var cachePath = path.join(storagePath, 'cache');
  // Ensure the cache path
  utils.ensureDir(cachePath);
  return new RawGithubCache(cachePath, cache);
};

RawGithubCache.prototype.getCachePath = function() {
  return this._cachePath;
};

RawGithubCache.prototype.middleware = function(req, res, next) {
  try {
    var user = req.params.user;
    var repo = req.params.repo;
    var tree = req.params.tree;
    var repoPath = req.params[0];

    // Check the cache if the response is found here
    var isRawKey = util.format('raw:%s', req.path);
    var isRaw = this._cache.get(isRawKey);
    if (!isRaw && isRaw !== null) {
      return next();
    }
    var repoIsPrivateKey = util.format('privateRepo:%s:%s', user, repo);
    var repoIsPrivate = this._cache.get(repoIsPrivateKey);
    if (repoIsPrivate) {
      return next();
    }

    var self = this;
    this.get(user, repo, tree, repoPath)
      .then(function (path) {
        self._cache.put(isRawKey, true);
        res.sendfile(path);
      })
      .catch(function (err) {
        if (err.message === 'NotFound') {
          self._cache.put(isRawKey, false);
          // Go to the next handler
          return next();
        }
        next(err);
      });
  } catch (err) {
    next(err);
  }
};

/**
 * Make a request to raw.github.com
 *
 * If there is an existing known etag this will be sent as a conditional request
 *
 * @param {String} [options.proxyStorageDir] path to proxy storage
 *
 * The callback is of (err, path) path is the path to file on the local filesystem
 */
RawGithubCache.prototype.get = function(user, repo, tree, repoPath) {
  var self = this;
  var deferred = Q.defer();
  try {
    this._downloadAndCache(user, repo, tree, repoPath, deferred);
  } catch(err) {
    debug('An error occcurred downloading the file.');
    deferred.reject(err);
  }

  return deferred.promise;
};

/**
 * Download and cache a file
 */
RawGithubCache.prototype._downloadAndCache = function(user, repo, tree, repoPath, deferred) {

  var localPath = this._getFilesLocalPath(user, repo, tree, repoPath);
  var githubUrl = this._getFilesGithubURL(user, repo, tree, repoPath);

  // Create a temporary filepath for the download
  var tempPath = temp.path();
  var tempStream = fs.createWriteStream(tempPath);
  debug("Attempting to retrieve `%s` into temp path `%s`", githubUrl, tempPath);

  var self = this;
  request.get(githubUrl)
    .parse(function(res, cb) {
      res.on('data', function(chunk) {
        tempStream.write(chunk);
      });
      res.on('end', function() {
        tempStream.close();
      });
    })
    .end(function(res) {

      try { // If the status code is not 200 or 304
        var statusCode = res.statusCode;
        if ([200, 304].indexOf(statusCode) === -1) {
          return deferred.reject(new Error('NotFound'));
        }

        utils.ensureDir(path.dirname(localPath));
        utils.copyFileSync(tempPath, localPath);

      } catch (err) {
        debug('Failure completing download : ' + githubUrl);;
        debug(err);
      } finally {
        // Clean up temp
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          /* ignore */
        }
      }

      // Return the path to the callback
      deferred.resolve(localPath);
    });
};

/**
 * Returns the local path for a file
 */
RawGithubCache.prototype._getFilesLocalPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath);
};

/**
 * Returns the github url for a file
 */
RawGithubCache.prototype._getFilesGithubURL = function(user, repo, tree, repoPath) {
  return util.format('https://raw.github.com/%s/%s/%s/%s', user, repo, tree, repoPath);
};

exports.RawGithubCache = RawGithubCache;