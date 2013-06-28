#!/usr/bin/env node
var express = require('express'),
    path = require('path'),
    fs = require('fs'),
    util = require('util'),
    utils = require('./utils'),
    ghutils = require('./github-utils'),
    cache = require('memory-cache'),
    RawGithubCache = ghutils.RawGithubCache,
    PrivateGithubCache = ghutils.PrivateGithubCache;

function createApp(program) {
  var MAX_CACHE_AGE_MS = program.maxCacheAge * 1000;
  var app = express();

  // LOAD CONFIG
  var configJSONPath = path.resolve(program.proxyStorageDir, 'proxy-config.json')
  var configJSON = JSON.parse(fs.readFileSync(configJSONPath, { encoding: 'utf-8' }));
  var rawCache = RawGithubCache.init(program.proxyStorageDir, 
                                     program.maxCacheAge);
  var privateCache = PrivateGithubCache.init(configJSON.token, 
                                             program.proxyStorageDir,
                                             program.maxCacheAge);
  
  
  app.get('/:user/:repo/:tree/*', 
    function(req, res, next) {
      var user = req.params.user,
          repo = req.params.repo,
          tree = req.params.tree; // Branch/tag/commit
      var repoPath = req.params[0];
      // Check the cache if the response is found here
      var isRawKey = util.format('raw:%s', req.path);
      var isRaw = cache.get(isRawKey);
      if(!isRaw && isRaw !== null) {
        return next();
      }
      var repoIsPrivateKey = util.format('privateRepo:%s:%s', user, repo);
      var repoIsPrivate = cache.get(repoIsPrivateKey);
      if(repoIsPrivate) {
        return next();
      }
      rawCache.get(user, repo, tree, repoPath, function(err, path) {
        if(err) {
          if(err.message === 'NotFound') {
            cache.put(isRawKey, false, MAX_CACHE_AGE_MS);
            // Go to the next handler
            return next();
          }
        }
        cache.put(isRawKey, true, MAX_CACHE_AGE_MS);
        res.sendfile(path);
      });
    },
    function(req, res, next) {
      var user = req.params.user,
          repo = req.params.repo,
          tree = req.params.tree; // Branch/tag/commit
      var repoPath = req.params[0];
      var isPrivateKey = util.format('private:%s', req.path);
      var isPrivate = cache.get(isPrivateKey);
      if(!isPrivate && isPrivate !== null) {
        return next();
      }
      privateCache.get(user, repo, tree, repoPath, function(err, path) {
        if(err) {
          if(err.message === 'NotFound') {
            // Go to the next handler
            cache.put(isPrivateKey, false, MAX_CACHE_AGE_MS);
            return next();
          }
        }
        // Make sure subsequent requests use this
        var repoIsPrivateKey = util.format('privateRepo:%s:%s', user, repo);
        cache.put(repoIsPrivateKey, true, MAX_CACHE_AGE_MS * 4);
        cache.put(isPrivateKey, true, MAX_CACHE_AGE_MS);
        res.sendfile(path);
      });
    },
    function(req, res) {
      res.send(404, 'File not found');
    }
  );
  return app;
}

exports.createApp = createApp;
