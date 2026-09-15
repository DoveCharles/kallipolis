// What the modules share. S holds the variables more than one module reassigns. App holds the functions and values a module
// needs from one that loads after it — each module adds its own at the end — so the modules still load, and run their setup,
// in the order the sections always ran in.
export const S = {};
export const App = {};
