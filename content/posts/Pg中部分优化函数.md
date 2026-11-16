---
title: "Pg中部分优化函数"
date: 2026-11-16
categories: ["pg基础"]
tags: ["PostgreSQL"]
---

## Pg中部分优化函数

这里统计我在pg读代码的时候遇到的各种优化函数

1.likely和unlikely

封装了__builtin_expect，优化cpu判断路径

例如原本if(x>0){} else{}，可改写为if(likely(x>0)) else{}

```c
/*
 * Hints to the compiler about the likelihood of a branch. Both likely() and
 * unlikely() return the boolean value of the contained expression.
 *
 * These should only be used sparingly, in very hot code paths. It's very easy
 * to mis-estimate likelihoods.
 */
#if __GNUC__ >= 3
#define likely(x)	__builtin_expect((x) != 0, 1)
#define unlikely(x) __builtin_expect((x) != 0, 0)
#else
#define likely(x)	((x) != 0)
#define unlikely(x) ((x) != 0)
#endif
```

