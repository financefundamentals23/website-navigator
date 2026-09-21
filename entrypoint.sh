#!/bin/sh
# Railway (and some other hosts) mount volumes owned by root, so the node user
# couldn't write the database. Railway's documented fix is to run everything as
# root; instead, fix ownership of /data as root and then drop to node for the
# actual process -- which drives a real browser around other people's sites.
set -e
if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
