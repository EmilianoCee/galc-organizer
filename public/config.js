// Supabase connection for group boards. Fill both fields in and the "Start a
// group board" button turns on; leave them null and the rest of the site works
// exactly as before, with boards showing a short setup note instead.
//
// See the "Group boards" section of README.md for the two-minute setup.
//
// The anon key is a PUBLIC key -- it is designed to ship in client code, and
// row-level security in supabase/schema.sql is what actually limits it. Note
// that this repo is public, so committing the key here means anyone who finds
// the repo can write to your boards. That is fine for a friends-only pick list;
// see the README if you would rather inject it from an Actions secret instead.

window.GALC_SUPABASE = {
  url: null, // e.g. 'https://abcdefghijklm.supabase.co'
  anonKey: null // the long 'anon public' key from Settings -> API
};
