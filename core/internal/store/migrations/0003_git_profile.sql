-- The git profile (SSH key from the server's ~/.git-profiles) a repo is cloned with.
ALTER TABLE repos ADD COLUMN git_profile text;
