#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int is_file(const char *p) {
  struct stat st;
  return p && stat(p, &st) == 0 && S_ISREG(st.st_mode);
}

static void set_path(void) {
  const char *home = getenv("HOME");
  char extra[PATH_MAX];
  extra[0] = '\0';
  if (home && home[0]) {
    snprintf(extra, sizeof(extra),
             "%s/Library/Python/3.13/bin:%s/.local/bin:", home, home);
  }
  char path[PATH_MAX * 2];
  snprintf(path, sizeof(path),
           "/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:"
           "/Library/Frameworks/Python.framework/Versions/3.13/bin:"
           "%s/usr/bin:/bin",
           extra);
  setenv("PATH", path, 1);
}

/* Tube Stash.app lives next to the project files. Executable is:
 *   <root>/Tube Stash.app/Contents/MacOS/Stash
 */
static int project_root(char *out, size_t cap) {
  char exe[PATH_MAX];
  uint32_t n = sizeof(exe);
  if (_NSGetExecutablePath(exe, &n) != 0) return -1;

  char resolved[PATH_MAX];
  if (!realpath(exe, resolved)) {
    strncpy(resolved, exe, sizeof(resolved) - 1);
    resolved[sizeof(resolved) - 1] = '\0';
  }

  char *marker = strstr(resolved, "/Tube Stash.app/Contents/MacOS/");
  if (!marker) marker = strstr(resolved, "/Stash.app/Contents/MacOS/");
  if (!marker) return -1;
  *marker = '\0';
  if (!resolved[0]) return -1;
  if (strlen(resolved) + 1 > cap) return -1;
  memcpy(out, resolved, strlen(resolved) + 1);
  return 0;
}

int main(void) {
  set_path();

  char root[PATH_MAX];
  if (project_root(root, sizeof(root)) != 0) {
    fprintf(stderr, "Tube Stash.app must stay inside the Tube Stash folder.\n");
    return 1;
  }

  char script[PATH_MAX];
  if (snprintf(script, sizeof(script), "%s/scripts/start.sh", root) >= (int)sizeof(script)) {
    return 1;
  }
  if (!is_file(script)) {
    fprintf(stderr, "Cannot find %s\nKeep Tube Stash.app next to the scripts folder.\n", script);
    return 1;
  }

  setenv("STASH_ROOT", root, 1);
  execl("/bin/bash", "bash", script, (char *)NULL);
  perror("execl");
  return 1;
}
