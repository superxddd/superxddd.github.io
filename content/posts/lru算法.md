---
title: "力扣 146：LRU 缓存算法"
date: 2026-05-29
draft: false
categories: ["基础算法"]
tags: ["LRU", "C++", "LeetCode", "缓存"]
description: "整理 LeetCode 146 LRU 缓存的设计思路与 C++ 实现。"
summary: "使用哈希表和双向链表实现 O(1) 的 get 和 put 操作。"
---

力扣lru算法——[146. LRU 缓存 - 力扣（LeetCode）](https://leetcode.cn/problems/lru-cache/description/)

请你设计并实现一个满足 [LRU (最近最少使用) 缓存](https://baike.baidu.com/item/LRU) 约束的数据结构。

实现 `LRUCache` 类：

- `LRUCache(int capacity)` 以 **正整数** 作为容量 `capacity` 初始化 LRU 缓存
- `int get(int key)` 如果关键字 `key` 存在于缓存中，则返回关键字的值，否则返回 `-1` 。
- `void put(int key, int value)` 如果关键字 `key` 已经存在，则变更其数据值 `value` ；如果不存在，则向缓存中插入该组 `key-value` 。如果插入操作导致关键字数量超过 `capacity` ，则应该 **逐出** 最久未使用的关键字。

函数 `get` 和 `put` 必须以 `O(1)` 的平均时间复杂度运行。

**示例：**

```
输入
["LRUCache", "put", "put", "get", "put", "get", "put", "get", "get", "get"]
[[2], [1, 1], [2, 2], [1], [3, 3], [2], [4, 4], [1], [3], [4]]
输出
[null, null, null, 1, null, -1, null, -1, 3, 4]

解释
LRUCache lRUCache = new LRUCache(2);
lRUCache.put(1, 1); // 缓存是 {1=1}
lRUCache.put(2, 2); // 缓存是 {1=1, 2=2}
lRUCache.get(1);    // 返回 1
lRUCache.put(3, 3); // 该操作会使得关键字 2 作废，缓存是 {1=1, 3=3}
lRUCache.get(2);    // 返回 -1 (未找到)
lRUCache.put(4, 4); // 该操作会使得关键字 1 作废，缓存是 {4=4, 3=3}
lRUCache.get(1);    // 返回 -1 (未找到)
lRUCache.get(3);    // 返回 3
lRUCache.get(4);    // 返回 4
```



首先确定用什么数据结构：

基于get()和put都要o(1)的要求。那么map查找和list的增删结合起来。符合要求。所以用

```c++
    list<pair<int,int>> lru_list_;
    unordered_map<int, list<pair<int,int>>::iterator> lru_map_;
```

需要注意的是，list并没有提供手写链表的head,next等。所以基于迭代器，要用splice方法来做节点的移动。

![lru算法力扣](/static/images/posts/lru算法力扣.png)

```c++
using namespace std;
#include <list>
#include <unordered_map>

class LRUCache {
public:
    // 双向链表，保存缓存的数据，pair<key,value>
    // 链表尾表示最近使用，链表头表示最久未使用
    list<pair<int,int>> lru_list_;

    // 哈希表，key -> 对应链表节点的迭代器
    // 用于 O(1) 查找节点
    unordered_map<int, list<pair<int,int>>::iterator> lru_map_;

    // 缓存容量
    int capacity_;

    // 构造函数，初始化缓存容量
    LRUCache(int capacity) {
        capacity_ = capacity;
    }
    
    // 获取 key 对应的 value
    int get(int key) {
        auto iter = lru_map_.find(key);  // 在哈希表中查找 key

        if(iter == lru_map_.end())       // 如果没找到，返回 -1
            return -1;

        // 将访问的节点移动到链表尾部，标记为最近使用
        lru_list_.splice(
            lru_list_.end(),  // 目标位置：链表尾
            lru_list_,        // 来源链表
            iter->second      // 要移动的节点
        );

        return iter->second->second; // 返回节点的 value
    }
    
    // 插入或更新 key-value
    void put(int key, int value) {
        if(lru_map_.find(key) == lru_map_.end()){ // key 不存在
            lru_list_.push_back({key,value});     // 插入链表尾部
            lru_map_[key] = prev(lru_list_.end()); // 记录节点迭代器
            if(lru_map_.size() > capacity_){      // 超过容量
                lru_map_.erase(lru_list_.begin()->first); // 删除最久未使用 key
                lru_list_.pop_front();                    // 删除链表头
            }
            return;
        }
        // key 已存在，更新 value
        lru_map_[key]->second = value;

        // 将节点移动到链表尾部，标记最近使用
        lru_list_.splice(lru_list_.end(), lru_list_, lru_map_[key]);
    }

};

/**
 * 使用示例：
 * LRUCache* obj = new LRUCache(capacity);
 * int param_1 = obj->get(key);
 * obj->put(key,value);
 */
```
