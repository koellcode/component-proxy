component-proxy - An extensible proxy server for component
==========================================================

To run a proxy (defaults to port 35555)::
    
    $ component proxy

To use during installation::
    
    $ component install -r http://127.0.0.1:35555

Or, for convenience (this will spawn a proxy if it is not running)::
    
    $ component proxy-install

By default the proxy will proxy and cache all requests to
https://raw.github.com. It can also be configured with credentials so that
private repositories can be accessed. In order to facilitate this, just run::
    
    $ component proxy-github-login

To setup the github credentials as an oauth token.

Configuring component-proxy
---------------------------

Tuning component-proxy will allow you to do some very powerful things without
changing your projects. 

Using the local source of a component
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

This is very useful for testing.

Long cache expiration
^^^^^^^^^^^^^^^^^^^^^

This allows you to store the files of a particular component for long periods
of time.
