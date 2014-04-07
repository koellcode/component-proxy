var path = require('path');
var fs = require('fs');
var util = require('util');
var utils = require('./utils');
var _ = require('underscore');
var debug = require('debug')('local-cache');

/**
 * Handles using locally cached repos.
 *
 * @param rawGithubCache
 * @param privateGithubCache
 * @constructor
 */
function LocalCache(rawGithubCacheDir, privateGithubCacheDir) {
  this.rawGithubCacheDir = rawGithubCacheDir;
  this.privateGithubCacheDir = privateGithubCacheDir;
  _.bindAll(this, 'middleware');
}

LocalCache.init = function(rawGithubCacheDir, privateGithubCacheDir) {
  return new LocalCache(rawGithubCacheDir, privateGithubCacheDir);
}

LocalCache.prototype.middleware = function(req, res, next) {
  var user = req.params.user;
  var repo = req.params.repo;
  var tree = req.params.tree; // Branch/tag/commit
  var repoPath = req.params[0];

  // Check locally cached public github repositories
  var localPath = path.join(this.rawGithubCacheDir, user, repo, tree, repoPath);
  if(fs.existsSync(localPath)) {
    debug("Using local cache %s", localPath);
    res.sendfile(localPath);
    return;
  }

  // Check locally cached private github repositories
  localPath = path.join(this.privateGithubCacheDir, 'extracted', user, repo, tree, repoPath);
  if(fs.existsSync(localPath)) {
    debug("Using private local cache %s", localPath);
    res.sendfile(localPath);
    return;
  }

  // Not in local cache
  next();
};

/**
 * Loads the current cache data for a file
 */
LocalCache.prototype._loadFilesCacheData = function(user, repo, tree, repoPath) {
  var cacheDataPath = this._getFilesCacheDataPath(user, repo, tree, repoPath);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8'}))
};

/**
 * Returns the path for the cache data for a file
 */
LocalCache.prototype._getFilesCacheDataPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath + '.cache');
};


module.exports.LocalCache = LocalCache;