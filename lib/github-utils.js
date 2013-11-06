var GithubApi = require('github'),
    fs = require('fs-extra'),
    request = require('superagent'),
    path = require('path'),
    _ = require('underscore'),
    util = require('util'),
    utils = require('./utils'),
    temp = require('temp'),
    AdmZip = require('adm-zip'),
    debug = require('debug')('github-caches');

// MAX CACHE TIME IN SECONDS
var MAX_CACHE_AGE = 120;

var defaultConnectionOptions = {
  authentication: null,
  proxyStorageDir: '~/.component-proxy'
}

var applyAuth = {
  oauth: function(req, auth) {
    return req.set('Authorization', 'token ' + auth.token);
  },
  basic: function(req, auth) {
    return req.auth(auth.username, auth.password);
  }
}

function connection(options) {
  options = _.extend({}, defaultConnectionOptions, options);

  var authentication = options.authentication;
  if(!authentication) {
    var configJSONPath = path.join(utils.expandAndResolve(options.proxyStorageDir), 'proxy-config.json');
    if(!fs.existsSync(configJSONPath)) {
      throw new Error('Authentication not provided.');
    }
    var configJSONRaw = fs.readFileSync(configJSONPath, { encoding: 'utf-8' });
    var configJSON = JSON.parse(configJSONRaw);
    authentication = {
      type: 'oauth',
      token: configJSON.token
    }
  }
  var requestMethod = function(method, url) {
    return applyAuth[authentication.type](request(method, url), authentication)
      .set('User-Agent', 'component-proxy');
  }
  return {
    get: function(url) {
      return requestMethod('GET', url)
    },
    post: function(url) {
      return request('POST', url);
    },
    method: requestMethod
  }
}

exports.connection = connection;

function SimpleGithub(connection) {
  this._connection = connection;
}

/**
 * Create a new simple github api that uses the current options to create a connection
 *
 * Options are the same as `connection`
 */
SimpleGithub.create = function(options) {
  var newConnection = connection(options);
  return new SimpleGithub(connection);
}

/**
 * Shortcut for connection get request
 */
SimpleGithub.prototype._get = function(url) {
  return this._connection.get(url);
}

/**
 * Shortcut for connection post request
 */
SimpleGithub.prototype._post = function(url) {
  return this._connection.post(url);
}

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
}

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
  }
  var copyTempFileToDest = function(dest) {
    utils.copyFileSync(tempPath, dest);
  }
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
        tempStream.close();
        cb(null, { copyTo: copyTempFileToDest });
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
  }
  // Save the cache data
  var cacheDataPath = this._getFilesCacheDataPath(user, repo, tree, repoPath);
  fs.writeFileSync(cacheDataPath, JSON.stringify(cacheData), { encoding: 'utf-8' });
}

/**
 * Loads the current cache data for a file
 */
RawGithubCache.prototype._loadFilesCacheData = function(user, repo, tree, repoPath) {
  var cacheDataPath = this._getFilesCacheDataPath(user, repo, tree, repoPath);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8'}))
}

/**
 * Returns the local path for a file
 */
RawGithubCache.prototype._getFilesLocalPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath);
}

/**
 * Returns the path for the cache data for a file 
 */
RawGithubCache.prototype._getFilesCacheDataPath = function(user, repo, tree, repoPath) {
  return path.join(this._cachePath, user, repo, tree, repoPath + '.cache');
}

/**
 * Returns the github url for a file
 */
RawGithubCache.prototype._getFilesGithubURL = function(user, repo, tree, repoPath) {
  return util.format('https://raw.github.com/%s/%s/%s/%s', user, repo, tree, repoPath);
}

exports.RawGithubCache = RawGithubCache;


/**
 * Allows access to private github repos
 *
 * It will cache and be as good a steward as possible when it comes to rate limiting
 */
function PrivateGithubCache(oauthToken, cachePath) {
  this._oauthToken = oauthToken;
  this._cachePath = cachePath;
  this._extractedPath = path.join(this._cachePath, 'extracted');
  this._connection = connection({
    authentication: { 
      token: oauthToken, 
      type: "oauth" 
    }
  });
}


PrivateGithubCache.init = function(oauthToken, storageDir) {
  var storagePath = utils.expandAndResolve(storageDir);
  var cachePath = path.join(storagePath, 'private-cache')
  // Ensure the cache path
  utils.ensureDir(cachePath);
  return new PrivateGithubCache(oauthToken, cachePath);
}

PrivateGithubCache.prototype._getLocalRepoZipballPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.zip', user, repo, tree));
}

PrivateGithubCache.prototype._getRepoCacheDataPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.cache', user, repo, tree));
}

PrivateGithubCache.prototype._loadRepoCacheData = function(user, repo, tree) {
  var cacheDataPath = this._getRepoCacheDataPath(user, repo, tree);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8' }));
}

PrivateGithubCache.prototype.get = function(user, repo, tree, repoPath, callback) {
  // Check if the repo zip on the file system
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);
  // Setup the finish callback to return the path to the requested file if it exists
  var self = this;
  var finish = function(err) {
    if(err) {
      return callback(err)
    }
    var filePath = path.join(self._extractedPath, user, repo, tree, repoPath);
    if(!fs.existsSync(filePath)) {
      return callback(new Error('NotFound'));
    }
    return callback(null, filePath);
  }
  if(!fs.existsSync(localPath)) {
    return this._downloadAndExtractRepoZip(user, repo, tree, {}, finish);
  }

  debug("Using local cache for private repo %s/%s@%s", user, repo, tree);
  return finish();
}

/**
 * Download and extract the repo zip
 */
PrivateGithubCache.prototype._downloadAndExtractRepoZip = function(user, 
                                                                   repo, 
                                                                   tree, 
                                                                   cacheData, 
                                                                   callback) {
  var cacheData = this._loadRepoCacheData(user, repo, tree);
  var githubURL = util.format('https://api.github.com/repos/%s/%s/zipball/%s', user, repo, tree);
  // Get local path
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);

  var self = this;

  // Request a zipball from github
  // Setup the default stuff
  var downloadZip = function(err, treeData, zipURL) {
    if(err) {
      return callback(err);
    }
    // Create a temporary filepath
    var tempPath = temp.path();
    debug("Retrieving zipball for repo `%s/%s@%s` into temp path `%s`", user, repo, tree, tempPath);
    // Create a stream for the temp file
    var tempStream = fs.createWriteStream(tempPath);
    var removeTempFile = function() {
      fs.unlinkSync(tempPath);
    }
    var copyTempFileToDest = function(dest) {
      utils.copyFileSync(tempPath, dest);
    }

    request.get(zipURL)
      .end(function(err, res) {
        if(err) {
          return callback(err);
        }
        var finish = function(err, zipRef) {
          if(res.statusCode !== 200) {
            debug("Could not access %s", zipURL);
            // Clean up temp
            removeTempFile();
            return callback(new Error('NotFound'));
          }
          // Copy the data to the local 
          zipRef.copyTo(localPath);
          // Update the cache data
          self._updateCache(user, repo, tree, treeData);
          // Clean up temp
          removeTempFile();
          // Extract since this is a new file
          self._extractRepoZip(user, repo, tree, localPath, callback);
        }
        res.on('data', function(chunk) {
          tempStream.write(chunk);
        });
        res.on('end', function() {
          tempStream.close();
          finish(null, { copyTo: copyTempFileToDest });
        });
      });
  };

  var getLocation = function(err, treeData, next) {
    var sha = treeData.commit.sha;
    // If the commits match then update the cache and return to the main callback
    if(cacheData.sha === sha) {
      self._updateCache(user, repo, tree, treeData);
      return callback();
    }
    var req = request.get(githubURL)
      .redirects(0)
      .set('Authorization', 'token ' + self._oauthToken)
      .set('User-Agent', 'component-proxy');
    // Add an etag to reduce ratelimiting effect
    if(cacheData.etag) {
      req.set('If-None-Match', cacheData.etag);
    }
    req.end(function(res) {
      var zipURL = res.header['location'];
      next(null, treeData, zipURL);
    });
  
  };
  
  var checkCurrentVersion = function(next) {
    // Check branches
    var branchesURL = util.format('https://api.github.com/repos/%s/%s/branches', 
                              user, repo);
    // Check branches
    var tagsURL = util.format('https://api.github.com/repos/%s/%s/tags', 
                              user, repo);
    var tagEtag = null;
    var branchEtag = null;
    if(cacheData.treeType === 'branch') {
      branchEtag = cacheData.etag;
    }
    if(cacheData.treeType === 'tag') {
      tagEtag = cacheData.etag;
    }
    self._get(branchesURL, branchEtag)
      .end(function(err, res) {
        if(res.statusCode === 304) {
          self._updateCache(user, repo, tree);
          return callback();
        }
        // Check tags
        var branches = {};
        _.each(res.body, function(branch) {
          var key = branch.name;
          branches[key] = branch;
        });
        var branchData = branches[tree];
        if(branchData) {
          branchData._treeMeta = {
            etag: res.header['etag'],
            type: 'branch'
          }
          return next(null, branchData, downloadZip)
        }
        self._get(tagsURL, tagEtag)
          .end(function(err, res) {
            if(res.statusCode === 304) {
              self._updateCache(user, repo, tree);
              return callback();
            }
            var tags = {};
            _.each(res.body, function(tag) {
              var key = tag.name;
              tags[key] = tag;
            });
            var tagData = tags[tree];
            // If there's no tag data then there's no tree to be found
            if(!tagData) {
              return callback(new Error('NotFound'));
            }
            // HACK to get etag in the requests
            tagData._treeMeta = {
              etag: res.header['etag'],
              type: 'tag'
            }
            return next(null, tagData, downloadZip)
          });
      });
  }
  checkCurrentVersion(getLocation);
}

PrivateGithubCache.prototype._get = function(url, etag) {
  var req =  this._connection.get(url);
  if(etag) {
    req.set('If-None-Match', etag);
  }
  return req;
}

PrivateGithubCache.prototype._updateCache = function(user, repo, tree, treeData) {
  var cacheData = null;
  if(!treeData) {
    // Load the current cache data
    cacheData = this._loadRepoCacheData(user, repo, tree);
    cacheData.timestamp = new Date().getTime();
  } else {
    // Update the cache data
    cacheData = {
      sha: treeData.commit.sha,
      timestamp: new Date().getTime(),
      treeType: treeData._treeMeta.type,
      etag: treeData._treeMeta.etag
    }
  }
  // Save the cache data
  var cacheDataPath = this._getRepoCacheDataPath(user, repo, tree);
  fs.writeFileSync(cacheDataPath, JSON.stringify(cacheData), { encoding: 'utf-8' });
}

PrivateGithubCache.prototype._extractRepoZip = function(user, repo, tree, zipPath, cb) {
  var destPath = path.join(this._extractedPath, user, repo, tree);
  // if the destination exists clean it up
  if(fs.existsSync(destPath)) {
    fs.removeSync(destPath);
  }
  // Make sure it exists
  utils.ensureDir(destPath);
  var zip = new AdmZip(zipPath)
  var zipEntries = zip.getEntries();
  // Unpack the zip
  zipEntries.forEach(function(zipEntry) {
    if(zipEntry.isDirectory) {
      return;
    }
    debug('Extracting %s', zipEntry.entryName)
    var entryPath = zipEntry.entryName;
    var entrySplitPath = entryPath.split(path.sep);
    var entryRelPath = entrySplitPath.slice(1).join(path.sep);
    var entryAbsPath = path.resolve(destPath, entryRelPath);
    var entryDirPath = path.dirname(entryAbsPath);
    var entryBuffer = zipEntry.getData();
    // Make sure it's parent directories exist
    utils.ensureDir(entryDirPath);
    // Write the file to disk
    fs.writeFileSync(entryAbsPath, entryBuffer);
  });
  cb();
}

exports.PrivateGithubCache = PrivateGithubCache;

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
