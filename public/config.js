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
  url: 'https://lwbvudjhkwsnstdqmsja.supabase.co', // e.g. 'https://abcdefghijklm.supabase.co'
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3YnZ1ZGpoa3dzbnN0ZHFtc2phIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxNTI5NzIsImV4cCI6MjEwMzcyODk3Mn0.qFZIAUhb78pJstvPD-Jev5xVQDI6OC3R-1sznE28gl8' // the long 'anon public' key from Settings -> API
};
