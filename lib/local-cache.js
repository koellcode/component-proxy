var path = require('path');
var fs = require('fs-extra');
var util = require('util');
var utils = require('./utils');
var _ = require('underscore');
var debug = require('debug')('local-cache');
var RepoValidator = require('./repo-validator');

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
    if (repoPath === 'component.json') {
      if (!this._validateCacheRepo(this.rawGithubCacheDir, user, repo, tree)) {
        return next();
      }
    }
    debug("Using local cache %s", localPath);
    res.sendfile(localPath);
    return;
  }

  // Check locally cached private github repositories

  var extracted = path.join(this.privateGithubCacheDir, 'extracted');
  localPath = path.join(extracted, user, repo, tree, repoPath);
  if(fs.existsSync(localPath)) {
    if (repoPath === 'component.json') {
      if (!this._validateCacheRepo(extracted, user, repo, tree)) {
        return next();
      }
    }
    debug("Using private local cache %s", localPath);
    res.sendfile(localPath);
    return;
  }

  // Not in local cache
  return next();
};

LocalCache.prototype._validateCacheRepo = function(baseDir, user, repo, tree) {
  var validator = new RepoValidator(baseDir, user, repo, tree);
  var result = validator.validate();

  // Remove the cached repo if it fails validation
  if (!result.valid) {
    var repoDir = path.join(baseDir, user, repo, tree);
    if (fs.existsSync(repoDir)) {
      fs.removeSync(repoDir);
    }
  }

  // For now just return true/false, later we can handle different scenarios
  return result.valid;
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