var GithubApi = require('github');
var fs = require('fs-extra');
var request = require('superagent');
var path = require('path');
var _ = require('underscore');
var util = require('util');
var utils = require('./utils');
var temp = require('temp');
var AdmZip = require('adm-zip');
var debug = require('debug')('raw-github-cache');


function RawGithubCache(cachePath) {
  this._cachePath = cachePath;
}

RawGithubCache.init = function(storageDir) {
  var storagePath = utils.expandAndResolve(storageDir);
  var cachePath = path.join(storagePath, 'cache')
  // Ensure the cache path
  utils.ensureDir(cachePath);
  return new RawGithubCache(cachePath);
}

RawGithubCache.prototype.getCachePath = function() {
  return this._cachePath;
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
RawGithubCache.prototype.get = function(user, repo, tree, repoPath, callback) {
  // Check if the file exists on the file system
  var localPath = this._getFilesLocalPath(user, repo, tree, repoPath);
  if(!fs.existsSync(localPath)) {
    // Load the file if it doesn't exist
    return this._downloadAndCache(user, repo, tree, repoPath, {}, callback);
  }
  // Load the file's .cache data
  var cacheData = this._loadFilesCacheData(user, repo, tree, repoPath);

  debug("Using local cache %s", localPath);
  return callback(null, localPath);
};

/**
 * Download and cache a file
 */
RawGithubCache.prototype._downloadAndCache = function(user, repo, tree, repoPath, cacheData, callback) {
  // Destination for cached file
  var localPath = this._getFilesLocalPath(user, repo, tree, repoPath);

  // Source for the file
  var githubURL = this._getFilesGithubURL(user, repo, tree, repoPath);

  // Create a temporary filepath
  var tempPath = temp.path();
  debug("Attempting to retrieve `%s` into temp path `%s`", githubURL, tempPath);
  // Create a stream for the temp file
  var tempStream = fs.createWriteStream(tempPath);
  var removeTempFile = function() {
    fs.unlinkSync(tempPath);
  };
  var copyTempFileToDest = function(dest) {
    utils.copyFileSync(tempPath, dest);
  };
  var req = request.get(githubURL)

  if(cacheData.etag) {
    req.set('If-None-Match', cacheData.etag);
  }

  var self = this;

  req
    .parse(function(res, cb) {
      res.on('data', function(chunk) {
        tempStream.write(chunk);
      });
      res.on('end', function() {
        tempStream.on('finish', function() {
          cb(null, { copyTo: copyTempFileToDest });
        });
        tempStream.close();
      });
    })
    .end(function(res) {
      var statusCode = res.statusCode;
      // If the status code is not 200 or 304
      if([200,304].indexOf(statusCode) === -1) {
        // Clean up temp
        removeTempFile();
        return callback(new Error('NotFound'));
      }
      // Update the cache data
      self._updateCache(user, repo, tree, repoPath, res, localPath);
      // Clean up temp
      removeTempFile();
      // Return the path to the callback
      return callback(null, localPath);
    });
}

/**
 * Caches a file
 *
 * If bytes is empty it will simple update the cache data file
 */
RawGithubCache.prototype._updateCache = function(user, repo, tree, repoPath, res, localPath) {
  // If the file changed
  if(res.statusCode === 200) {
    debug("Updating latest version to %s", localPath);
    // Ensure the directory exists
    utils.ensureDir(path.dirname(localPath));
    // Copy the file to the localPath
    res.body.copyTo(localPath);
  } else {
    debug("Version did not change for %s", localPath);
  }
  // Update the cache data
  var cacheData = {
    etag: res.header['etag'],
    timestamp: new Date().getTime()
  };
  // Save the cache data
  var cacheDataPath = this._getFilesCacheDataPath(user, repo, tree, repoPath);
  fs.writeFileSync(cacheDataPath, JSON.stringify(cacheData), { encoding: 'utf-8' });
};

/**
 * Loads the current cache data for a file
 */
RawGithubCache.prototype._loadFilesCacheData = function(user, repo, tree, repoPath) {
  var cacheDataPath = this._getFilesCacheDataPath(user, repo, tree, repoPath);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8'}))
};

/**
 * Returns the local path for a file
 */
RawGithubCache.prototype._getFilesLocalPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath);
};

/**
 * Returns the path for the cache data for a file
 */
RawGithubCache.prototype._getFilesCacheDataPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath + '.cache');
};

/**
 * Returns the github url for a file
 */
RawGithubCache.prototype._getFilesGithubURL = function(user, repo, tree, repoPath) {
  return util.format('https://raw.github.com/%s/%s/%s/%s', user, repo, tree, repoPath);
};

exports.RawGithubCache = RawGithubCache;


/**
 * Make a request to raw.github.com
 *
 * If there is an existing known etag this will be sent as a conditional request
 *
 * @param {String} [options.proxyStorageDir] path to proxy storage
 */
function getFromRaw(user, repo, tree, path, options, callback) {
  options = _.extend({}, defaultConnectionOptions, options);
  var cachePath = path.resolve(utils.expandAndResolve(options.proxyStorageDir), 'cache')
  var filePath = path.join(cachePath, user, repo, tree, path);
  // Check if the file exists on the file system
  if(fs.existsSync(filePath)) {

  }
  // Check if the file has a .cache file
  // If the .cache file is 30 seconds or younger then use the file on the filesystem
  // Otherwise, make a conditional request for the data
  // If the response is a 304 or 200 update the data do not cache any other requests
}

