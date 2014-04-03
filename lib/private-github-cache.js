var GithubApi = require('github');
var fs = require('fs-extra');
var request = require('superagent');
var path = require('path');
var _ = require('underscore');
var util = require('util');
var utils = require('./utils');
var temp = require('temp');
var AdmZip = require('adm-zip');
var debug = require('debug')('private-github-cache');
var Q = require('q');

var defaultConnectionOptions = {
  authentication: null,
  proxyStorageDir: '~/.component-proxy'
};

var applyAuth = {
  oauth: function(req, auth) {
    return req.set('Authorization', 'token ' + auth.token);
  },
  basic: function(req, auth) {
    return req.auth(auth.username, auth.password);
  }
};

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
};

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
};

PrivateGithubCache.prototype.getCachePath = function() {
  return this._cachePath;
};


PrivateGithubCache.prototype._getLocalRepoZipballPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.zip', user, repo, tree));
};

PrivateGithubCache.prototype._getRepoCacheDataPath = function(user, repo, tree) {
  return path.join(this._cachePath, util.format('%s-%s-%s.cache', user, repo, tree));
};

PrivateGithubCache.prototype._loadRepoCacheData = function(user, repo, tree) {
  var cacheDataPath = this._getRepoCacheDataPath(user, repo, tree);
  if(!fs.existsSync(cacheDataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(cacheDataPath, { encoding: 'utf-8' }));
};

PrivateGithubCache.prototype.get = function(user, repo, tree, repoPath) {

  var deferred = Q.defer();

  // Check if the repo zip on the file system
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);

  // Setup the finish callback to return the path to the requested file if it exists
  var self = this;
  var filePath = path.join(self._extractedPath, user, repo, tree, repoPath);

  if(!fs.existsSync(localPath)) {
    this._downloadAndExtractRepoZip(user, repo, tree, {})
      .then(function success() {

        if(!fs.existsSync(filePath)) {
          return deferred.reject(new Error('NotFound'));
        }

        deferred.resolve(filePath)
      })
      .catch(function error(err) {
        deferred.reject(err);
      });
  } else {
    debug("Using local cache for private repo %s/%s@%s", user, repo, tree);
    deferred.resolve(filePath);
  }

  return deferred.promise;
};

/**
 * Download and extract the repo zip
 */
PrivateGithubCache.prototype._downloadAndExtractRepoZip = function(user,
                                                                   repo,
                                                                   tree,
                                                                   cacheData) {
  var deferred = Q.defer();

  this.checkCurrentVersion(user, repo, tree, cacheData, deferred);
  return deferred.promise;

};

PrivateGithubCache.prototype.checkCurrentVersion = function(user,
                                                            repo,
                                                            tree,
                                                            cacheData,
                                                            deferred) {
  var cacheData = this._loadRepoCacheData(user, repo, tree);

  // Check branches
  this.getLocation(user, repo, tree, deferred);
};



PrivateGithubCache.prototype.getLocation = function(user, repo, tree, deferred) {
  var self = this;

  var githubURL = util.format('https://api.github.com/repos/%s/%s/zipball/%s', user, repo, tree);
  var req = request.get(githubURL)
    .redirects(0)
    .set('Authorization', 'token ' + self._oauthToken)
    .set('User-Agent', 'component-proxy');

  req.end(function(res) {
    var zipUrl = res.header['location'];
    self.downloadZip(user, repo, tree, zipUrl, deferred);
  });
};

PrivateGithubCache.prototype.downloadZip = function(user, repo, tree, zipUrl, deferred) {
  var self = this;
  // Get local path
  var localPath = this._getLocalRepoZipballPath(user, repo, tree);

  // Create a temporary filepath
  var tempPath = temp.path();
  debug("Retrieving zipball for repo `%s/%s@%s` into temp path `%s`", user, repo, tree, tempPath);
  // Create a stream for the temp file
  var tempStream = fs.createWriteStream(tempPath);

  request.get(zipUrl)
    .end(function(err, res) {
      if(err) {
        return deferred.reject(err);
      }

      res.on('data', function(chunk) {
        try {
          tempStream.write(chunk);
        } catch (err) {
          deferred.reject(err);
        }
      });
      res.on('end', function() {
        try {
          tempStream.close();
          if(res.statusCode !== 200) {
            debug("Could not access %s", zipUrl);
            // Clean up temp
            fs.unlinkSync(tempPath);
            return deferred.reject(new Error('NotFound'));
          }

          utils.ensureDir(path.dirname(localPath));
          utils.copyFileSync(tempPath, localPath);
          self._updateCache(user, repo, tree, undefined);
          fs.unlinkSync(tempPath);
          self._extractRepoZip(user, repo, tree, localPath, deferred);
        } catch (err) {
          deferred.reject(err);
        }
      });
    });
};

PrivateGithubCache.prototype._get = function(url, etag) {
  var req =  this._connection.get(url);
  if(etag) {
    req.set('If-None-Match', etag);
  }
  return req;
};

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
};

PrivateGithubCache.prototype._extractRepoZip = function(user, repo, tree, zipPath, deferred) {
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
  deferred.resolve();
};

exports.PrivateGithubCache = PrivateGithubCache;
