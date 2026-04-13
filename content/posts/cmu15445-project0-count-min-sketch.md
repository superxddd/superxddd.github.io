---
title: "CMU 15-445 Project 0：Count-Min Sketch 实现笔记"
date: 2026-03-31
draft: false
categories: ["cmu15445"]
tags: ["Count-Min Sketch", "C++", "并发", "bustub"]
description: "整理 CMU 15-445 Project 0 中 Count-Min Sketch 的实现思路、移动语义处理和常见坑点。"
summary: "围绕 Count-Min Sketch 的构造、移动语义、插入、合并、查询与 TopK 做一份结构化整理。"
---

开头先看一下 `count_min_sketch` 算法的解析：

[Count-min Sketch 算法 - 知乎](https://zhuanlan.zhihu.com/p/369981005)

然后开始写第一个构造函数。

先不考虑并发，构造一个 `x*y` 的矩阵，比如 `vector<vector<uint32_t>>`：

|      | 1    | 2    | 3    |
| ---- | ---- | ---- | ---- |
| 0    | 0    | 0    | 0    |
| 1    | 0    | 0    | 0    |

但是考虑到性能问题，一维数组可能更好一点，我们可以人工划分，用 `vector<uint32_t>` 就行：

| 0.1  | 0.2  | 0.3  | 1.1  | 1.2  | 1.3  | 2.1  | 2.2  | 2.3  | ...... |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ------ |

```c++
/**
 * count-min sketch 的构造函数。
 *
 * @param width sketch 矩阵的宽度。
 * @param depth sketch 矩阵的深度。
 * @throws std::invalid_argument 当 width 或 depth 为 0 时抛出。
 */
template <typename KeyType>
CountMinSketch<KeyType>::CountMinSketch(uint32_t width, uint32_t depth)
    : width_(width), depth_(depth), sketch_(width * depth, 0) {
  /** @TODO(student) Implement this function! */
  if (width == 0 || depth == 0) throw(std::invalid_argument("wrong"));
  /** @spring2026 请不要修改以下内容 */
  // 初始化带种子的哈希函数
  hash_functions_.reserve(depth_);
  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }
}
```

第二个是移动构造函数。

`sketch_` 用 `move` 函数，`width_` 和 `depth_` 直接赋值就行。

最关键的是 `HashFunction`。

**最关键的问题是 `HashFunction` 生成的 lambda 捕获了 `this`。把这些 lambda move 到新对象后，它们内部记录的仍然是旧对象地址，不会自动改成新对象地址，因此不能直接复用，只能重新生成。**

```c++
inline auto HashFunction(size_t seed) -> std::function<size_t(const KeyType &)> {
  return [seed, this](const KeyType &item) -> size_t {
    auto h1 = std::hash<KeyType>{}(item);
    auto h2 = bustub::HashUtil::CombineHashes(seed, SEED_BASE);
    return bustub::HashUtil::CombineHashes(h1, h2) % width_;
  };
}
```

所以直接照抄上面的 `hash_functions_` 初始化部分，最终函数为：

```c++
template <typename KeyType>
CountMinSketch<KeyType>::CountMinSketch(CountMinSketch &&other) noexcept
    : width_(other.width_), depth_(other.depth_), sketch_(std::move(other.sketch_)) {
  /** @TODO(student) Implement this function! */
  hash_functions_.reserve(depth_);
  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }
}
```

第三个，移动赋值运算符。

基本上同上：

```c++
template <typename KeyType>
auto CountMinSketch<KeyType>::operator=(CountMinSketch &&other) noexcept -> CountMinSketch & {
  /** @TODO(student) Implement this function! */
  if (this == &other) return *this;
  this->sketch_ = std::move(other.sketch_);
  this->width_ = other.width_;
  this->depth_ = other.depth_;

  hash_functions_.reserve(depth_);
  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }

  return *this;
}
```

第四个，插入函数。

首先这里插入是同 [Count-min Sketch 算法 - 知乎](https://zhuanlan.zhihu.com/p/369981005) 里面讲的：

![img](https://picx.zhimg.com/v2-97c121d1d38fa93e2b16ad40b4596437_1440w.jpg)

步骤大约是：

1. 先用每一行的 hash 函数对要插入的元素做 hash，计算 hash 值，这里的 hash 值应该是下标。
2. 每一行的对应的 hash 值 +1。

比如插入的是 3，`h1=1,h2=3,h3=4`，那么就如下图：

![img](https://pic3.zhimg.com/v2-7cb6c0c143dc9f35dc519d4c4d3a846a_1440w.jpg)

```c++
template <typename KeyType>
void CountMinSketch<KeyType>::Insert(const KeyType &item) {
  /** @TODO(student) Implement this function! */
  // auto guard = std::lock_guard<std::mutex>(latch_);(加锁)
  for (size_t i = 0; i < depth_; i++) {
    int hashcount = (hash_functions_[i](item));
    (this->sketch_[i * width_ + hashcount])++;
  }
}
```

第五个，合并函数。

他大概是多线程做 hash 插入，然后最后多表做合并，所以这部分就是矩阵相加就行。

```c++
template <typename KeyType>
void CountMinSketch<KeyType>::Merge(const CountMinSketch<KeyType> &other) {
  if (width_ != other.width_ || depth_ != other.depth_) {
    throw std::invalid_argument("Incompatible CountMinSketch dimensions for merge.");
  }
  /** @TODO(student) Implement this function! */
  // auto guard = std::scoped_lock(latch_, other.latch_);(加锁)
  for (size_t i = 0; i < this->sketch_.size(); i++) {
    this->sketch_[i] += other.sketch_[i];
  }
}
```

第六个，计数函数。

这个其实就是插入反过来。

比如我查询 3 这个元素出现的次数，那么也是这几步：

先对这个元素，用每行的 hash 函数计算 hash 值。

然后每行查询，查询每行该 hash 值对应的下标是多少，取最小值。（因为 hash 冲突会导致 hash 变大，比如 1 和 3 可能在某一行的 hash 值相同，但是它们只是分别出现了一次。）

```c++
template <typename KeyType>
auto CountMinSketch<KeyType>::Count(const KeyType &item) const -> uint32_t {
  uint32_t res = std::numeric_limits<uint32_t>::max();
  auto guard = std::lock_guard<std::mutex>(latch_);
  for (size_t i = 0; i < depth_; i++) {
    int hashcount = (hash_functions_[i](item));
    res = (this->sketch_[i * width_ + hashcount]) < res ? (this->sketch_[i * width_ + hashcount]) : res;
  }
  return res;
}
```

第七个，清零函数。

我个人理解是用 0 填充矩阵，用 `for` 循环也行，我这里直接用的库函数：

```c++
template <typename KeyType>
void CountMinSketch<KeyType>::Clear() {
  /** @TODO(student) Implement this function! */
  std::fill(sketch_.begin(), sketch_.end(), 0);
}
```

第八个，查询函数，要查询给的数组里面出现次数最多的 `k` 个元素。

先初始化一个返回值 `std::vector<std::pair<KeyType, uint32_t>> resvec;`

对参数的数组做 hash，然后插入返回的数组，然后做排序，截取。

这里应该可以优化，做大堆顶。

```c++
template <typename KeyType>
auto CountMinSketch<KeyType>::TopK(uint16_t k, const std::vector<KeyType> &candidates)
    -> std::vector<std::pair<KeyType, uint32_t>> {
  /** @TODO(student) Implement this function! */
  std::vector<std::pair<KeyType, uint32_t>> resvec;
  for (size_t i = 0; i < candidates.size(); i++) {
    resvec.push_back({candidates[i], this->Count(candidates[i])});
  }
  std::stable_sort(resvec.begin(), resvec.end(), [](const auto &a, const auto &b) { return a.second > b.second; });
  if (resvec.size() > k) resvec.resize(k);
  return resvec;
}
```

![测试截图](/images/posts/count-min-sketch-contestion-test.png)

加锁以后的测试截图。

原子化笔记：

首先用 atomic 在头文件声明数组：

```c
  std::vector<std::atomic<uint32_t>> sketch_;//一维数组，减少性能开销
```

其次将每一道题都改写成原子的形式，用 `fetch_add` 和 `store/load` 等函数读取。就能确保测试准确通过。逻辑同上，并无更改。

```c++
//===----------------------------------------------------------------------===//
//
//                         BusTub
//
// count_min_sketch.cpp
//
// Identification: src/primer/count_min_sketch.cpp
//
// Copyright (c) 2015-2025, Carnegie Mellon University Database Group
//
//===----------------------------------------------------------------------===//

#include "primer/count_min_sketch.h"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>

namespace bustub {

/**
 * count-min sketch 的构造函数。
 *
 * @param width sketch 矩阵的宽度。
 * @param depth sketch 矩阵的深度。
 * @throws std::invalid_argument 当 width 或 depth 为 0 时抛出。
 */
template <typename KeyType>
CountMinSketch<KeyType>::CountMinSketch(uint32_t width, uint32_t depth)
    : width_(width), depth_(depth), sketch_(width * depth) {
  /** @TODO(student) Implement this function! */
  if (width == 0 || depth == 0) throw(std::invalid_argument("wrong"));

  for (auto &x : sketch_) {
    x.store(0, std::memory_order_relaxed);
  }

  /** @spring2026 请不要修改以下内容 */
  // 初始化带种子的哈希函数
  hash_functions_.reserve(depth_);
  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }
}

template <typename KeyType>
CountMinSketch<KeyType>::CountMinSketch(CountMinSketch &&other) noexcept
    : width_(other.width_), depth_(other.depth_), sketch_(std::move(other.sketch_)) {
  /** @TODO(student) Implement this function! */

  hash_functions_.clear();
  hash_functions_.reserve(depth_);

  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }
}

template <typename KeyType>
auto CountMinSketch<KeyType>::operator=(CountMinSketch &&other) noexcept -> CountMinSketch & {
  /** @TODO(student) Implement this function! */
  if (this == &other) return *this;
  this->sketch_ = std::move(other.sketch_);
  this->width_ = other.width_;
  this->depth_ = other.depth_;

  hash_functions_.clear();
  hash_functions_.reserve(depth_);
  for (size_t i = 0; i < depth_; i++) {
    hash_functions_.push_back(this->HashFunction(i));
  }

  return *this;
}

template <typename KeyType>
void CountMinSketch<KeyType>::Insert(const KeyType &item) {
  /** @TODO(student) Implement this function! */
  for (size_t i = 0; i < depth_; i++) {
    size_t hashcount = (hash_functions_[i](item));
    (this->sketch_[i * width_ + hashcount]).fetch_add(1, std::memory_order_relaxed);
  }
}

template <typename KeyType>
void CountMinSketch<KeyType>::Merge(const CountMinSketch<KeyType> &other) {
  if (width_ != other.width_ || depth_ != other.depth_) {
    throw std::invalid_argument("Incompatible CountMinSketch dimensions for merge.");
  }
  /** @TODO(student) Implement this function! */
  for (size_t i = 0; i < this->sketch_.size(); i++) {
    const auto value = other.sketch_[i].load(std::memory_order_relaxed);
    this->sketch_[i].fetch_add(value, std::memory_order_relaxed);
  }
}

template <typename KeyType>
auto CountMinSketch<KeyType>::Count(const KeyType &item) const -> uint32_t {
  uint32_t res = std::numeric_limits<uint32_t>::max();
  for (size_t i = 0; i < depth_; i++) {
    size_t hashcount = (hash_functions_[i](item));

    const auto value = (this->sketch_[i * width_ + hashcount]).load(std::memory_order_relaxed);
    res = std::min(res, value);
  }
  return res;
}

template <typename KeyType>
void CountMinSketch<KeyType>::Clear() {
  /** @TODO(student) Implement this function! */
  for (auto &x : sketch_) {
    x.store(0, std::memory_order_relaxed);
  }
}

template <typename KeyType>
auto CountMinSketch<KeyType>::TopK(uint16_t k, const std::vector<KeyType> &candidates)
    -> std::vector<std::pair<KeyType, uint32_t>> {
  /** @TODO(student) Implement this function! */
  std::vector<std::pair<KeyType, uint32_t>> resvec;
  for (size_t i = 0; i < candidates.size(); i++) {
    resvec.push_back({candidates[i], this->Count(candidates[i])});
  }
  std::stable_sort(resvec.begin(), resvec.end(),
                   [](const auto &a, const auto &b) { return a.second > b.second; });
  if (resvec.size() > k) resvec.resize(k);
  return resvec;
}

// 为测试中使用到的所有类型进行显式实例化
template class CountMinSketch<std::string>;
template class CountMinSketch<int64_t>;  // 用于 int64_t 测试
template class CountMinSketch<int>;      // 这里同时覆盖 int 和 int32_t
}  // namespace bustub
```

测试图：

![测试图](/static/images/posts/count-min-sketch-contestion-test.png)
