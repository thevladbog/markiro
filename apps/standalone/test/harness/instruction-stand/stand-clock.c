// The stand's host clock (macOS only): loaded into markiro-host with DYLD_INSERT_LIBRARIES, it
// moves the wall clock by STAND_CLOCK_OFFSET seconds, so the host lives on the stand's day while
// it runs for real. Monotonic clocks are untouched. Never part of a product build.
//   clang -dynamiclib -o stand-clock.dylib stand-clock.c
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

static long offset_seconds(void) {
  static long offset = 0;
  static int read = 0;
  if (!read) {
    const char *value = getenv("STAND_CLOCK_OFFSET");
    offset = value ? atol(value) : 0;
    read = 1;
  }
  return offset;
}

static int stand_clock_gettime(clockid_t id, struct timespec *tp) {
  int result = clock_gettime(id, tp);
  if (result == 0 && id == CLOCK_REALTIME) tp->tv_sec += offset_seconds();
  return result;
}

static int stand_gettimeofday(struct timeval *tv, void *tz) {
  int result = gettimeofday(tv, tz);
  if (result == 0 && tv) tv->tv_sec += offset_seconds();
  return result;
}

static time_t stand_time(time_t *out) {
  time_t now = time(NULL) + offset_seconds();
  if (out) *out = now;
  return now;
}

__attribute__((used)) static struct {
  const void *replacement;
  const void *original;
} interposers[] __attribute__((section("__DATA,__interpose"))) = {
    {(const void *)stand_clock_gettime, (const void *)clock_gettime},
    {(const void *)stand_gettimeofday, (const void *)gettimeofday},
    {(const void *)stand_time, (const void *)time},
};
