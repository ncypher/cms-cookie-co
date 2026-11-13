-- Photo Studio: keep a re-encoded copy of the untouched photo next to each framed one, so "Edit photo"
-- can start again from the real picture. NULL for photos uploaded before the studio existed.
ALTER TABLE specials ADD COLUMN image_orig_key TEXT;
ALTER TABLE events ADD COLUMN flyer_orig_key TEXT;
ALTER TABLE media ADD COLUMN orig_key TEXT;
