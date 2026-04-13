---
title: "CMU 15-445 Project 0：LRU 基础版实现笔记"
date: 2026-04-13
draft: false
categories: ["cmu15445"]
tags: ["LRU", "C++", "bustub", "缓存淘汰"]
description: "整理 CMU 15-445 Project 0 中 LRU 基础版的实现思路与核心数据结构。"
summary: "围绕 LRU 的基本思想、示例、数据结构设计以及 Victim、Pin、Unpin 等接口做一份简洁整理。"
---

# cmu-15445 LRU 笔记

## Least Recently Used（最近最少使用）

LRU 是一种缓存淘汰策略，用于管理有限容量的缓冲池。缓冲池满时，会淘汰最久未使用的元素。

它的核心思想很直接：谁最近被访问过，谁就更应该留下；谁长时间没被访问，谁就更适合被淘汰。
在数据库缓冲池里，这种策略很常见，因为它实现简单，而且通常能取得不错的效果。

## 示例

缓存容量为 3 时：

```
put(1)
put(2)
put(3)
get(1)
put(4)
```

操作后的状态：
- 前三步：缓冲池已满，顺序为 3 2 1
- `get(1)`：1 被访问后移到最新位置，顺序变为 1 3 2
- `put(4)`：淘汰最旧的 2，顺序变为 4 1 3

这里可以把最左边理解成“最新访问”，最右边理解成“最久没访问”。
这样一来，每次有新元素加入，或者某个元素被再次访问时，就把它移动到最前面；需要淘汰时，直接从最后面拿走即可。

## 实现

LRU 需要 `O(1)` 的 `get` 和 `put` 操作。

数据结构如下：
- `std::list<frame_id_t> lru_list_`：存储 `frame_id`，按访问顺序排列
- `std::unordered_map<frame_id_t, std::list<frame_id_t>::iterator> f_map_`：用于快速查找和定位

这里只用一种结构不够方便：

- 如果只用链表，虽然能维护访问顺序，但查找某个元素是否存在会比较慢。
- 如果只用哈希表，虽然查找很快，但没法自然地维护“谁最近访问、谁最久没访问”的顺序。

所以这里把两者结合起来：

- 链表负责维护顺序。
- 哈希表负责在 `O(1)` 时间内找到链表中的位置。

这个组合是实现 LRU 的经典写法。

在这份实现里，链表头部表示最近访问的元素，尾部表示最久未访问的元素。
因此：

- `Unpin` 时把页面插到链表头部，表示它现在可以被替换，并且是最近进入 LRU 的。
- `Pin` 时把页面从 LRU 中移除，表示它正在被使用，暂时不能被替换。
- `Victim` 时从链表尾部取出元素，因为那里正是最久未使用的页面。

### `lru_replacer.cpp`

```c++
//===----------------------------------------------------------------------===//
//
//                         BusTub
//
// lru_replacer.cpp
//
// Identification: src/buffer/lru_replacer.cpp
//
// Copyright (c) 2015-2025, Carnegie Mellon University Database Group
//
//===----------------------------------------------------------------------===//

#include "buffer/lru_replacer.h"

namespace bustub {

/**
 * 创建一个新的 LRUReplacer。
 * @param num_pages LRUReplacer 需要管理的最大页数
 */
LRUReplacer::LRUReplacer(size_t num_pages): lru_list_(), f_map_(num_pages) {
    
}

/**
 * 析构 LRUReplacer。
 */
LRUReplacer::~LRUReplacer() = default;

auto LRUReplacer::Victim(frame_id_t *frame_id) -> bool {
    if(lru_list_.empty()) {
        return false;
    }
    mutex_.lock();
    *frame_id = lru_list_.back();
    lru_list_.pop_back();

    f_map_.erase(*frame_id);
    mutex_.unlock();
     return true; 
    }

void LRUReplacer::Pin(frame_id_t frame_id) {
    if(f_map_.find(frame_id) == f_map_.end()) {
        return;
    }
    mutex_.lock();
    lru_list_.erase(f_map_[frame_id]);
    f_map_.erase(frame_id);
    mutex_.unlock();
}

void LRUReplacer::Unpin(frame_id_t frame_id) {
    if(f_map_.find(frame_id) != f_map_.end()) {
        return;
    }
    mutex_.lock();
    lru_list_.push_front(frame_id);
    f_map_[frame_id] = lru_list_.begin();
    mutex_.unlock();
}


auto LRUReplacer::Size() -> size_t { return lru_list_.size(); }

}  // namespace bustub

```

上面几个函数的职责其实很清楚：

- `Victim`：从 LRU 中选出一个牺牲页，也就是当前最久未使用的页。
- `Pin`：把某个页从可替换集合中移除。
- `Unpin`：把某个页重新放回可替换集合。
- `Size`：返回当前 LRU 中可被替换的页数。

构造函数里主要是初始化容器，析构函数这里则直接使用默认实现。
真正的核心逻辑集中在 `Victim`、`Pin` 和 `Unpin` 三个接口上。

### `lru_replacer.h`

```c++
//===----------------------------------------------------------------------===//
//
//                         BusTub
//
// lru_replacer.h
//
// Identification: src/include/buffer/lru_replacer.h
//
// Copyright (c) 2015-2025, Carnegie Mellon University Database Group
//
//===----------------------------------------------------------------------===//

#pragma once

#include <list>
#include <mutex>  // NOLINT
#include <vector>
#include <unordered_map>

#include "buffer/replacer.h"
#include "common/config.h"

namespace bustub {

/**
 * LRUReplacer 实现了最近最少使用（Least Recently Used, LRU）替换策略。
 */
class LRUReplacer : public Replacer {
 public:
  explicit LRUReplacer(size_t num_pages);

  ~LRUReplacer() override;

  auto Victim(frame_id_t *frame_id) -> bool override;

  void Pin(frame_id_t frame_id) override;

  void Unpin(frame_id_t frame_id) override;

  auto Size() -> size_t override;

 private:
  // TODO(student): 请在这里完成实现。
  std::list<frame_id_t> lru_list_;
  std::unordered_map<frame_id_t, std::list<frame_id_t>::iterator> f_map_;
  std::mutex mutex_;

};

}  // namespace bustub

```

头文件部分主要定义了类的接口和成员变量，没有太多额外逻辑。
真正需要关注的，还是链表、哈希表以及互斥锁这三个成员：

- `lru_list_` 负责维护访问顺序。
- `f_map_` 负责从 `frame_id` 快速定位到链表节点。
- `mutex_` 用来保证并发访问时的数据安全。

整体来看，这一版 LRU 的思路并不复杂，重点就是把“顺序维护”和“快速定位”结合起来。
只要理解了这两个结构各自负责什么，再去看 `Victim`、`Pin`、`Unpin` 的实现，就会顺很多。

![image-20260413151009331](/static/images/posts/image-20260413151009331.png)
