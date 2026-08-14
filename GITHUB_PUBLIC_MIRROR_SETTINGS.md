# Public Mirror Settings

Recommended settings for the public PeerLink Servers source mirror:

- block force pushes on `main`;
- block branch deletion on `main`;
- require linear history where practical;
- restrict updates to the trusted source-publication actor or bot where
  practical.

This repository is an automated source mirror. Snapshot commits may be created
directly by the trusted publication actor if PR-based publication is not used.

Source tags are immutable. Never move or force-push a source tag. If incorrect
source is published under a tag, publish a corrected version and tag instead of
replacing the existing tag.
