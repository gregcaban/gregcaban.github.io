---
title: 'Decorating JVM Stack Traces for Fun and Profit - Part 3'
description: 'How to extend OpenJDK to enrich stack traces with runtime metadata like OTEL trace IDs, span attributes, and application context.'
pubDate: 'Mar 21 2026'
---

## Intro
This is the third and final installment of my mini series about decorating JVM stack traces, [part 1](/blog/jvm-stack-decorator) is a natural place to start. In [part 2](/blog/jvm-stack-decorator-part-2) we built the simplest decorator, that allows JVM applications to set a `decoratingContext` string on a `java.lang.Thread` object and then added that string to each frame when a stack trace was printed for that thread. We used it to build a [demo microservice](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/simplest-decorator?tab=readme-ov-file), that decorated stack frames with HttpMethod and URL of received request, by appending something like  `[GET /debug/thread-dump]` to each line. This was great fun and relatively simple to do, but also had serious problems we discussed at the end of that post. The big one was the fact that for stack traces in Exceptions we were fetching our `decoratingContext` string from current Thread at stack trace, not backtrace, construction time which don't have to happen at the same time or even on the same Thread! I'm going to cover why in more detail in this post, but what we'll spend most time on building is extending our demo app to support "OTEL like" method Annotation that behind the scenes will call into JDK and push provided attributes wrapped in `decoratingContext` object, so that they can be used to decorate call frames of this specific method. In short, my goal is to implement the final and most exciting use case discussed in introduction of part 1, which is to dynamically inject telemetry from frameworks like OTEL into JVM stack traces. When I say "implement" of course I mean implement enough to give a good demo, please don't use it in production! 

We're going to start by quickly covering backtrace, why it's important for our little project and how we can leverage this pattern for our goals. 

 
## What is a backtrace? 
 
In [part 2](/blog/jvm-stack-decorator-part-2), I referred to this thing called the backtrace and how it's involved in constructing the stack trace, but that it will be covered later. Well this section is that later, now is the time to cover stack trace vs backtrace and we need both. Both are a data structure that represents call frames of user level (or application level) executing on the JVM on a given Thread. In both cases each call frame contains what you'd expect, some information about the method being called, where we are in this method's body. What's the difference then? They have different internal representation (think memory data format) and the sole reason the backtrace exists as far as I'm aware, is to make capturing the call stack of newly created Exception (Throwable to be specific) as fast as possible without losing any information. At this stage it's also worth highlighting that constructing the full stack trace which can be printed to a format familiar to most people who at least occasionally look at logs and happen to run on JVM, constructing that stack trace is a relatively expensive operation. Not only we need to allocate a bunch of Java objects (StackTraceElement), but we also need to pull quite a lot of metadata together. We're starting the stack walking with a native HotSpot object like [javaVFrame](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/runtime/vframe.hpp#L109) 

```cpp

class javaVFrame: public vframe {
 public:
  // JVM state
  virtual Method*                      method()         const = 0;
  virtual int                          bci()            const = 0;
//..
``` 
which contains a pointer to the Java `Method` in question and a `bci` for Byte Code Index. The latter as you can probably guess can tell us which instruction in the method's body we're currently "at", meaning either currently executing or more likely where we called a method above us in the stack and we're waiting for it to return. This is very low level state and quite a lot of pointer chasing and general data loading needs to happen before we can translate that into a nice StackTraceElement object that can be printed like 

```sh
java.base/java.lang.reflect.Method.invoke(Method.java:565)
```
We need to follow the [`Method*`](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/oops/method.hpp#L68) to find the method name, also [`InstanceKlass`](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/oops/instanceKlass.hpp#L134) behind its [`method_holder`](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/oops/method.hpp#L500) where we can get the class name and source file, module, class loader, etc. Method will also hold a [`LineNumberTable`](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/oops/method.hpp#L496) which is used to convert `bci` to a source code line number. Arguably C++ is really fast at chasing pointers and most of those operations are just that: following pointers to find already in memory class metadata. Besides `bci` -> `lineno` conversion, which does require a bit of logic to find the correct line in the original source code matching current bytecode. This is just to give you an idea of the sort of work that needs to happen. The most expensive part is probably allocating all those Java String objects required to copy and store this information as fields of StackTraceElement (we can't use internal JVM pointers anymore!), plus of course actual StackTraceElement instance. And this is just for a single call frame!

How does HotSpot achieve the goal of exceptions being fast to throw and having detailed human readable stack traces? 

It's done by delaying as much work as possible till later, to avoid blocking the throwing Thread, which cannot continue until this operation is finished. The solution is the idea of `backtrace`, which captures all needed information but it still uses the HotSpot native representation (think pointers to internal JVM metadata) and delays the conversion to Java friendly format for later. Until that happens [backtrace](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L129) is just a field on Throwable, storing a reference to an opaque Object with a following comment 

```java
/**
 * The JVM saves some indication of the stack backtrace in this slot.
 */
private transient Object backtrace;
   
```
which is one way to say "please don't mess with it", but of course feel free to poke around in a debugger, next time you have an Exception at hand. 

Stack trace construction will happen if and when user code actually asks for it, usually by calling [Throwable.getStackTrace()](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L857) which will pass its [backtrace](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L866) field.  Eventually [StackTraceElement.of](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L563) method calls into HotSpot and asks it to convert that backtrace object into a proper `StackTraceElement[]`. 

One important assumption behind this design is that in most real life JVM applications there are many more exceptions that are thrown than ones that have their stack trace printed, because for instance most exceptions are caught and the catch handler isn't always walking the stack trace. That means it's worth paying the extra complexity to make throwing new exceptions fast and only making clients pay as they go (as they walk… the stack). This also partially explains why there are multiple separate implementations of stack walking in JVM, as we hinted at in the previous section. They're optimised for different use patterns. 

I'm going through all of this in a lot of detail, because 
- I personally find it very interesting to learn more about the internals of the API that many of us use almost every day
- For our stack decorator we'll try to leverage this principle. We need to store extra metadata to enrich some frames, but we do want to delay the additional work as much as possible, at least for Throwables. 

## OTel use case
Coming back to where we left our little project at the end of [part 2](/blog/jvm-stack-decorator-part-2). We've compiled our own custom JDK, built a very naive global stack trace decorator and we've learned a bit about the JVM internal handling of Java threads, although there is so much to be said about threads, stacks and other HotSpot machinery that makes our JVM app run, it's a topic we could spend a lot of time on. For instance, remember that HotSpot C++ class we used to get our method pointer and byte code index, it was called `javaVFrame`. Have you wondered what the `V` might stand for? You guessed it, it's "Virtual". So, when people talk about virtual threads vs platform threads — if you're HotSpot, all that Java stuff above you is virtual, even the platform threads. 

Back to the main topic. We've shown how simple global per thread state (or "DecorationContext") could be used for enriching stack frames, but it's very hard to imagine how that toy example could be extended to cover those exciting use cases we talked about at the beginning. Even if one has very good imagination, I wouldn't really blame you for not seeing how this approach could be used to enrich call frames with OTEL spanID and even help developers understand very complicated stack traces produced by some async reactive framework built on virtual threads. Let's try to implement a prototype of how that could work and what it would look like from the application perspective. That way we can have a better feel of whether this would be a useful thing to build. 

Now don't get me wrong, this is still going to be a toy prototype. Actually building something like this on a JDK is a serious engineering endeavour and our goal here will be to build just enough to have a working demo, which is very far from production code. Having said that, if you're anything like me, you'll also find it fun and satisfying seeing something working end to end, not just sketching some APIs and diagrams. 

What's the demo? I like the idea of addressing the OTEL integration because it's a realistic use case people care about. If this solution could automatically enrich stack trace frames with traceID, spanID and maybe some attributes, that would demonstrate the value clearly. When I say automatically, I mean there were a JDK API that would allow OTEL and other telemetry libraries to push a `DecoratingContext` to HotSpot for say a method containing an OTEL span.  On top of that, if the solution would also seamlessly work with virtual threads, by propagating that context across different platform threads, that could be incredibly helpful for those sometimes mind-bending stack traces produced by various reactive frameworks or coroutines. 

Let's imagine we're building a Spring Boot microservice and we have that new type of OTEL annotation we can add to our endpoint handler, that looks something like this : 

```java
@DecorateStackTrace(
	value = "OperationName", 
	properties = {"arbitrary", "key", "value", "pairs"})

```

and that behind the scenes builds on top of annotations like OTEL [@WithSpan](https://opentelemetry.io/docs/zero-code/java/agent/annotations/#creating-spans-around-methods-with-withspan), creating spanId for this method etc. Only `@DecorateStackTrace` will also take care of calling our new JDK API and pushing a `DecoratingContext` onto our thread, that will include current trace and span IDs, but also whatever additional attributes we provide. Then if we happen to throw an exception and print the stack into logs, for each frame with that annotation, we'll append `[trace=8cbd5293944f0d548fdc3a6577b3fc39 span=7a28297b7926b5b8 op=OperationName arbitrary=key value=pairs]` to its line in the stack trace, like this: 

```sh
java.lang.Exception:
	at com.example.myapp.MyController.myMethod(MyController.java:32) [trace=8cbd5293944f0d548fdc3a6577b3fc39 span=7a28297b7926b5b8 op=OperationName arbitrary=key value=pairs]
	at java.base/jdk.internal.reflect.Dir
... 
```
You get the idea! And it needs to work with virtual threads, regardless of which platform thread we started and where we eventually dumped the stack, the context must follow us between platform threads. 
Hopefully it's pretty obvious that our first attempt at adding the decorating context would fail spectacularly at this. Not only does it decorate all frames in the stack, while we'll only want to enrich the annotated methods, but it currently carries a single context and we want to add different metadata for different methods and maybe even different values for different calls to the same method, like some counters or other metrics. It's unclear how well it would handle the virtual thread scenario, it might actually work ok, since vthreads were so transparently integrated into existing API, but there is a bigger and more nuanced problem. In the section about [backtrace](#what-is-a-backtrace) we explained the mechanism used to delay stack trace construction and in our naive simple decorator we modified only the latter to use `DecoratingContext` if we happen to find it on currentThread. Since we now understand those don't necessarily need to happen at the same time or even at the same thread, it's pretty obvious there is a problem. We could easily end up decorating the stack trace with the wrong metadata. My idea is to evolve the simple decorator that grows a list of DecoratingContexts for each annotated method along with the call stack and when exception is thrown and backtrace captured on Throwable instance, we'll also transfer that list from thread to throwable. 


    Thread (call stack)                   Thread.decoratingContext
              │                                │
              ▼                                ▼
    ┌─────────────────────────┐
    │ DebugController         │          ┌───────────────────┐
    │   .getOrder()       ──────────────▶│ op=getOrder       │
    │                         │  match   │ trace=a1 span=c3  │
    ├─────────────────────────┤          │ layer=controller  │
    │ Spring AOP / CGLIB      │          └────────┬──────────┘
    ├─────────────────────────┤                   │ next
    │ Interceptor             │                   ▼
    │   .traceMethod()        │          ┌───────────────────┐
    ├─────────────────────────┤          │ op=GET /orders/99 │
    │ DispatcherServlet       │          │ trace=a1 span=e5  │
    │   .doDispatch()         │          │ service=order-svc │
    ├─────────────────────────┤          └───────────────────┘
    │ DecoratingContextFilter │                   ▲
    │   .doFilter()       ───────────────────────┘
    └─────────────────────────┘            match
    
    
Every time we call a method annotated with `@DecorateStackTrace` we push new context onto our list along with provided metadata. When we generate stack trace, we walk the stack top to bottom and if the method on the frame matches DecoratingContext currently at the head of our list, pop that value and use it to decorate the frame. Very simple and leaving a lot of responsibility on the client, they're responsible for making sure that for each relevant call site, they only push one decorating context. If they get it wrong, their stack trace will look odd, but hopefully that's something that's fairly easy to fix and we're leaving them the ability to fix it, instead of trying to manage it from the JVM side. 

So far that could be implemented as just a simple extension of first prototype, just replace the `String decoratingContext` field with a linked list data structure, but how are we going to handle the backtrace capture? We can follow the elegant pattern implemented by HotSpot, just need to make sure we transfer the ownership of our list from Thread to Throwable instance at the same time as backtrace is captured. It would end up looking like this: 
 

       Throwable.backtrace             Throwable.decoratingContext
              │                                │
              ▼                                ▼
       ┌──────────────┐  match  ◀───── ctx₁ (getOrder)
       │ getOrder :33 │════════════▶  set STE.decoratingContext = ctx₁
       ├──────────────┤
       │ AOP/CGLIB    │               ctx₂ (doFilter) ◀── advance
       ├──────────────┤
       │ traceMethod  │                     │
       ├──────────────┤                     │
       │ doDispatch   │                     │
       ├──────────────┤  match  ◀───────────┘
       │ doFilter :60 │════════════▶  set STE.decoratingContext = ctx₂
       ├──────────────┤
       │ Tomcat       │
       ├──────────────┤
       │ Thread.run   │
       └──────────────┘

and with that, we can walk both lists together using the same logic as described above when building the stack trace. 

Finally to make sure we don't introduce any unnecessary slow downs into that highly optimized code, we're going to implement this stack frame to context matching in native HotSpot code, extending native methods called during stack trace construction like [StackTraceElement::initStackTraceElements](https://github.com/openjdk/jdk/blob/814b7f5d2a76288b6a8d6510a10c0241fdb727d0/src/java.base/share/classes/java/lang/StackTraceElement.java#L563). Thanks to that decision the changes were fairly minimal, could re-use existing stack walking loop and only add fast matching logic (comparison of `Method*` pointers between backtrace frame and context, which is about as fast as possible), without a need to introduce additional pass in Java. The other added benefit of implementing it in C++, was the fact that I could reuse a lot of the code (and definitely the pattern) between the two main stack trace building implementations in JDK, there are quite a few remember? I ended up implementing one called from `Throwable` and `Thread::getStackTrace()` / `java.lang.Thread.getAllStackTraces()`. The latter two methods capture stack using JVM safepoints and that implementation was fully in C++, so it was necessary to extend them in HotSpot. I completely punted on the JFR implementation as it's very different. Bottom line, I implemented a working version of this on my fork of jdk, branch [feature/otel-decorator](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/otel-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R401). 

Also the [feature/otel-decorator](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/otel-decorator) branch of the demo service includes "fake" OTEL [annotation](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/9882fe7afbe58bc7b5d46a8a68a7574e118638ef/src/main/java/com/example/orders/DecorateStackTrace.java#L16) and fully working microservice with several endpoints annotated like 

```java
@DecorateStackTrace(value = "getOrder", properties = {"layer", "controller", "component", "orders"})
@GetMapping(value = "/orders/{id}", produces = MediaType.TEXT_PLAIN_VALUE)
public String getOrder(@PathVariable long id)

```

and as you see on the stack trace below, each frame dedicated to [getOrder](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/9882fe7afbe58bc7b5d46a8a68a7574e118638ef/src/main/java/com/example/orders/DebugController.java#L31) endpoint is decorated with the metadata provided in our annotation `[trace=7e6cd128... span=80824c80... op=getOrder layer=controller component=orders]`. 

```sh
$ curl http://localhost:8080/debug/orders/9090
com.example.orders.OrderNotFoundException: Order not found: 9090
    at com.example.orders.DebugController.getOrder(DebugController.java:33)
        [trace=7e6cd128... span=80824c80... op=getOrder layer=controller component=orders]
    at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104)
    at java.base/java.lang.reflect.Method.invoke(Method.java:565)
    ...
    at com.example.orders.DecoratingContextFilter.doFilter(DecoratingContextFilter.java:60)
        [trace=7e6cd128... span=7f8a9b0e... op=GET /debug/orders/9090 layer=filter component=http]
    ...
```
It works, feel free to take it for a spin. You will have to build a custom JDK in order to run though, but hopefully I provided detailed enough [instructions](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/otel-decorator?tab=readme-ov-file#prerequisites) on how to do that. 


One more thing we haven't mentioned: How can the JVM know how to render `DecoratingContext` into String, since it's passed around as an opaque `Object` reference. We allow users to provide a new interface [StackTraceDecoratingContextRenderer.java](https://github.com/gregcaban/jdk/blob/feature/otel-decorator/src/java.base/share/classes/java/lang/StackTraceDecoratingContextRenderer.java) with a single method 

```java 
String render(Object metadata);
```

and if the application provides its own [implementation](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/otel-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R401) it will be used by StackTraceElement.toString. [Here](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/9882fe7afbe58bc7b5d46a8a68a7574e118638ef/src/main/java/com/example/orders/OrdersApplication.java#L12) is how the demo app sets it up. It's then used to convert the opaque context into human readable string. 

Finally we've also added an [endpoint](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/448c53e85bd3a91ff0e5b79eb16610afe9f8e05f/src/main/java/com/example/orders/DebugController.java#L129) that does a little fan out spinning off multiple Virtual Threads:

```java
try (var executor = Executors.newThreadPerTaskExecutor(
                Thread.ofVirtual().name("enrichment-", 0).factory())) {
            var futures = new LinkedHashMap<String, Future<?>>();
            for (String item : items) {
                futures.put(item, executor.submit(() -> {
                    Map<String, String> metadata = new LinkedHashMap<>();
                    metadata.put("trace", traceId);
                    metadata.put("span", DecoratingContextFilter.randomHex(8));
                    metadata.put("op", "enrichItem");
                    metadata.put("item", item);
                    metadata.put("thread", Thread.currentThread().getName());

                    Thread.currentThread().pushDecoratingContext(
                            new StackTraceDecoratingContext(ENRICH_ITEM_METHOD, metadata));

                    // Yield point — virtual thread may migrate to a different carrier
                    Thread.sleep(5);

                    enrichItem(item);
                    return item;
                }));
            }
```            

 to show that vthreads can also be decorated and if one of them throws an exception, that we won't lose that metadata even if we throw on a vthread and catch on the parent platform [thread](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/448c53e85bd3a91ff0e5b79eb16610afe9f8e05f/src/main/java/com/example/orders/DebugController.java#L161). 

Everything works as expected: 
```sh

curl http://localhost:8080/debug/vthread-fanout
Parallel enrichment of 3 items (trace=2e0b099e209e682113678336d8ef52d2)

--- SKU-100 ---
OK

--- SKU-200 ---
OK

--- SKU-FRAUD ---
java.lang.IllegalStateException: Fraud score 0.95 exceeds threshold 0.80 for SKU-FRAUD
	at com.example.orders.DebugController.runFraudCheck(DebugController.java:196)
	at com.example.orders.DebugController.enrichItem(DebugController.java:188) [trace=2e0b099e209e682113678336d8ef52d2 span=33a893f8d77157b5 op=enrichItem item=SKU-FRAUD thread=enrichment-2]
	at com.example.orders.DebugController.lambda$vthreadFanout$0(DebugController.java:153)
	at java.base/java.util.concurrent.FutureTask.run(FutureTask.java:330)
	at java.base/java.util.concurrent.ThreadPerTaskExecutor$ThreadBoundFuture.run(ThreadPerTaskExecutor.java:323)
	at java.base/java.lang.VirtualThread.run(VirtualThread.java:470)

```

## The End?

That's it, it's been a fun project and I definitely learned a lot while building it, I hope you found it interesting. I'm not sure if there is a Part 4, as at this stage I pretty much accomplished my main goal of having a nice working demo showing how an "OTEL-like" annotation could decorate JVM stack traces. I might add a more elaborate summary and perhaps some next steps, but not today. Thanks for reading! 