// Supabase connection for group boards.
//
// These stay null in the repo. The deploy workflow fills them in from the
// repository secrets SUPABASE_URL and SUPABASE_ANON_KEY, so the credentials
// live in GitHub's secret store rather than in version control.
//
// With both null, the board panel shows a short setup note and the rest of the
// site works exactly as it does now.
//
// For local development you can fill these in by hand -- just leave that edit
// uncommitted. See the "Group boards" section of README.md.

window.GALC_SUPABASE = {
  url: null,
  anonKey: null
};
