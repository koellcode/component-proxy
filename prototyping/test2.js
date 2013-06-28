var RGC = require('./lib/github-utils').RawGithubCache;

var rgc = RGC.init('~/.component-proxy', 120);
rgc.get('virtru-components', 'q', 'master', 'component.json', function(err, path) { 
  console.log("Error %s", err); 
  console.log("Res: %s", path); 
})
