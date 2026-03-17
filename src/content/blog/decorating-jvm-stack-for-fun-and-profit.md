---
title: 'Decorating JVM StackTraces for Fun and Profit'
description: 'How to extend OpenJDK to enrich stack traces with runtime metadata like OTEL trace IDs, span attributes, and application context.'
pubDate: 'Mar 12 2026'
---

# Decorating JVM StackTraces for Fun and Profit

## Intro 
Last year I had an opportunity to do some hacking on the OpenJDK fork that my employer maintains internally and I want to capture what I learned about JDK development in general and the specific topic, which happens to be stack traces. This blog post and linked repos is an attempt at doing just that and I'm doing it for the benefit of future me, as much as anyone else who might be interested. If you're wondering why a SaaS company like ServiceNow maintains a fork of OpenJDK, besides having a fork of Javascript Engine (my main area of work) and a fork of Postgres, I know I hear you.. I guess the "not invented here" is strong at ServiceNow. The positive side is that it gives people like me a rare opportunity to really deep dive into some of the most foundational technologies of our era. In what will probably turn out to be a short series of blog posts, I'm going to explore how to build a custom image of JDK from sources, including some basic extensions like adding a new class [Java Class Library - Wikipedia](https://en.wikipedia.org/wiki/Java_Class_Library) or extending existing one, then move on to the main topic which is digging into how JVM stack traces are created and how to decorate them with more application level data.

## Why would I ever want any of that?
Good question! Curiosity how things are put together and the joy of tinkering is an obvious answer, but of course you might have a particular goal in mind.  Like that bit of functionality you always wanted to add to the Java standard library or perhaps you were curious if you can implement a Garbage Collector. The topic I worked on and will cover here is much less ambitious than a new GC. I will be writing about the StackTraces and how could we enrich them at runtime. 

My stack traces are fine, I hear you say, what else could I possibly want to add to them? Frankly many complain that the JVM stack traces already have too much information (or at least too many frames) in them. 

The use case I was working on, which sadly I can't cover in full details, was related to that Javascript Engine (fork of [mozilla/rhino](https://github.com/mozilla/rhino) I mentioned earlier. Since we're running Javascript on JVM, we often have useful metadata about the code being run that we wanted to pass on to the JVM at runtime, so that when a StackTrace is constructed, this information can be included. The goal being to make the stack trace much more relatable to the javascript code users wrote and less to the JVM and rhino internals. I don't want to get into too many details, but think about call frames representing to Javascript functions you wrote being easy to find on the stack trace vs being shown [org.mozilla.rhino.Interpreter.interpretLoop](https://github.com/mozilla/rhino/blob/4bf1df91036c7627f817d037aa768c3f79a9f8d8/rhino/src/main/java/org/mozilla/javascript/Interpreter.java#L1571) and other rhino internal call frames. I understand this is quite a niche usecase, few people might have this problem, but it hopefully illustrates the more general pattern. You might be interested in decorating the JVM stack trace with some other application or business domain level information, so that the frames are related to your business logic and your mental model of the problem the code is solving, making debugging issues so much easier. Let's give a few examples, to make more concrete. 

Perhaps you're labelling your servers/pods/threads with some unique tag to help make sense from logs and other telemetry. Well if you could set that unique tag on the JVM process start up and have each frame decorated with it, that would mean each time stack trace is printed (like in thrown and caught exception), you know exactly where it originated from. Each thread being tagged with a unique tag might also be a very handy idea, because you can probably find machine Id in the logs, but each machine might have many JVM processes running many threads, so having unique threadId in the stack trace might be interesting to some, especially if you can give your threads some logical names/ids. This idea becomes even more powerful with the arrival of Project Loom and it's potential of "millions" of virtual threads. Moving your application to leverage thousands of virtual threads, it's becoming increasingly challenging to to depend on Thread name or ThreadLocal, which were the typical ways to solve preserve that sort of logical context. This use case extends quite naturally into Kotlin coroutines and async frameworks where it's often a challenge do reconstruct what was the logical stack trace from the "physical" JVM level frames. If you're not interested in servers, how about the service name and version, set at deployment? How many times have you looked at the exception and wondered: has this process running the latest version?

Another telemetry related idea, is that if you collect some runtime metrics like maybe number of in-flight transaction, number of concurrent users or similar throughput/latency related metrics, wouldn't it be awesome to attach those to exception stack trace and throw time? So that you can later see that this error happened when your metric was close to it's P99 value. 

Finally that leaves us to the most interesting in my opinion use case, which is integrating telemetry from frameworks like OTEL into your frames. Even something as simple as decorating frames with the active trace ID and span ID at the time they were entered you could automatically correlate any exception thrown with the rest of your distributed trace without all the current plumbing that usually depends on injecting those IDs into your logging framework. Again, this could be game changing for async and reactive code where context propagation is usually challenging. But wait, there is more! One could imagine decorating frames with OTEL span attribute and other semantic context. Think things like `http.method`, `http.route`, `db.system` etc. How powerful would that be to see stack frames showing `POST /api/orders`, `env: PROD` and `postgres: dev-DB` right there in the exception stack trace. Wait, why is PROD trying to connect to `dev-DB` ?!?

I hope by now I've made it clear that this would be a useful thing to have and you probably have a lot of questions about the feasibility of it, not to mention the performance cost. We'll discuss it all, but first we need to take a short side quest and learn how to develop OpenJDK locally. 

## OpenJDK development 101 or how to build your own JVM
This section will cover how to setup your local development environment for OpenJDK, feel free to skip this part if you're already familiar with it. The  [official docs](https://github.com/openjdk/jdk/blob/master/doc/building.md) are actually really good, but I'm going to repeat the core steps plus cover some gotchas below. In theory, all you need to do is: 

```sh
$ git clone https://git.openjdk.org/jdk
$ cd jdk
$ bash configure
$ make images
```

it will run for a while, especially the last 2 cmds, but eventually you'll be able to test your freshly baked jvm using: 

```sh
$ ./build/macosx-x86_64-server-release/images/jdk/bin/java -version
openjdk version "27-internal" 2026-09-15
OpenJDK Runtime Environment (build 27-internal-adhoc.cab.jdk)
OpenJDK 64-Bit Server VM (build 27-internal-adhoc.cab.jdk, mixed mode, sharing)
```

Congratulations, you've just managed to build your own JVM. Most Java developers in the world probably never get this far. 

In practive I've run into a few problems. 

### The Boot JDK Catch-22
`bash configure` script responsible for finding and setting up local dependencies. If you only have JDK 17 and 21 installed like I did, `configure` might struggle to find a compatible BootJDK and it will print something like this 

```sh
checking for version string... 27-internal-adhoc.cab.jdk
configure: Found potential Boot JDK using /usr/libexec/java_home
configure: Potential Boot JDK found at /usr/local/Cellar/openjdk@17/17.0.15/libexec/openjdk.jdk/Contents/Home is incorrect JDK version (openjdk version "17.0.15" 2025-04-15 OpenJDK Runtime Environment Homebrew (build 17.0.15+0) OpenJDK 64-Bit Server VM Homebrew (build 17.0.15+0, mixed mode, sharing)); ignoring
configure: (Your Boot JDK version must be one of: 25 26 27)
... 
configure: Could not find a valid Boot JDK. OpenJDK distributions are available at http://jdk.java.net/.
configure: This might be fixed by explicitly setting --with-boot-jdk
configure: error: Cannot continue
/Users/cab/Dev/JDK/blog_jdk/jdk/build/.configure-support/generated-configure.sh: line 84: 5: Bad file descriptor
configure exiting with result code 1
```

OpenJDK needs a working JDK to bootstrap itself, it's called BootJDK. The problem here is that we're trying to build JDK 27, version on current main and BootJDK needs to be at most 2 versions older than the version you're currently trying to build. Hence the `Your Boot JDK version must be one of: 25 26 27` log above. You might not have any of those installed or configure script cannot find them. Two solutions, either switch your code from `main` branch to older version like `jdk23` or you need to help the script find your local installation. I'm going to stick to `main` branch for the rest of this post and finish configure with
```sh
bash configure --with-boot-jdk=/usr/local/opt/openjdk@25/
```
### Running Tests

Want to run the test suite as well? OpenJDK ships with extensive test suite, [check testing docs](https://github.com/openjdk/jdk/blob/master/doc/testing.md), but to run it you're going to need [jtreg](https://ci.adoptium.net/view/Dependencies/job/dependency_pipeline/lastSuccessfulBuild/artifact/jtreg/), the JDK's bespoke test framework. Sadly there is no `mvn install` or `cargo add`, welcome to the past, make sure to wear your steampunk goggles.

```bash
# Download jtreg
curl -LO https://ci.adoptium.net/view/Dependencies/job/dependency_pipeline/lastSuccessfulBuild/artifact/jtreg/jtreg-8.2.1+1.tar.gz
tar xzf jtreg-7.5.1+1.tar.gz

# Optional: Google Test for HotSpot C++ unit tests
git clone --depth 1 --branch v1.14.0 https://github.com/google/googletest.git
```

Once those are downloaded, `configure` again: 

```sh
# Reconfigure
bash configure --with-boot-jdk=/usr/local/opt/openjdk@25/ \
               --with-jtreg=../jtreg \
               --with-gtest=../googletest

# Run tier1 (the "fast" tests — still thousands of them)
make test-tier1
```

Above also configures [gtest](https://github.com/google/googletest) for running C++ written HotSpot tests. We'll need it later, so I'll configure both here, but feel free to skip it. It won't be required for the next part. 


## Adding a simple class to JCL
What I'll cover now is show the smallest example I could think that both shows how to extend openjdk standard library (the [JCL](https://en.wikipedia.org/wiki/Java_Class_Library)) and demonstrates the main pattern of allowing application code decorating jvm stack trace, by calling a new API and providing some application specific information. This is a toy example, it intentionally oversimplifies and glosses over many issues in order for the code to stay as small as simple as possible. 

The goal is to sketch enough of a implementation in JDK to allow us to build a demo microservice that enriches stack traces with extra `POST /api/orders` added to the usual class, method and source file info. That demo exists and can be found [here](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/simplest-decorator) if you're interested in getting a better sense of what we're aiming to build. 

I'm going to focus now on openjdk changes required to build that demo app. At the high level what we need to build is:
1. Add a new public method or class allowing application to add it's data to be used for StackTrace decoration. I'm going to call this piece of data `decorating context` and for now it's going to be just a single String. 
1. Extend the logic where StackTrace is constructed to check if `decorating context` was added and use it to decorate StackTraceElement objects
1. that's it, at least for now. It's that simple!

We're going to implement it in a simplest way possible and the new API will be just a couple of public methods and a String field on the familiar `java.lang.Thread` class. New methods are essentially a getter and setter for the new `String decoratingContext` field, you can find the changes [here](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-2a5b4b651fa41e70f7953f7ee06e964d8396fcd1fe5755a1609e81b3f84d9224R1812) on my fork. 

Using this String in the logic that creates StackTrace is a bit more interesting as there are several code paths that produce an `StackTraceElement[]` objects and they often have a completely different implementation. For this demo we're going to focus on the first, most common and simplest one to extend, completly ignoring the hard native C++ ones. Having said that it's still worth enumerating all of them: 
1. [java.lang.Throwable.getStackTrace(backtrace, depth)](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L857), one you might be familiar with. It's most commonly used for printing stack of exceptions, but also often recommended as a fast way to dump current Thread's stack if needed. It internally calls [StackTraceElement.of](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L556) method which calls into HotSpot to populate the `StackTraceElement`s using data captured in backtrace. I'm going to cover stack trace vs backtrace in the next section. 

2. [java.lang.StackFrameInfo.toStackTraceElement()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackFrameInfo.java#L152) (used by [StackWalker](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/test/jdk/jdk/internal/vm/Continuation/java.base/java/lang/StackWalkerHelper.java#L60)) calls [StackTraceElement.of(StackFrameInfo)](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L570) which allows users to lazily walk the stack without fully materlialising all frames. This obviously could be much more efficient if you're only interested in finding a specific frame, hopefully near the top of the stack. This might give you an idea that eagerly creating StackTraceElement array is an expensive operation and you're not wrong about it. It was added in Java 9.

3. [java.lang.Thread.getStackTrace()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2206) when called on a instance other than [current thread](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2207), will call into [native HotSpot API](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2213) to materialize the stack trace. After this method is called the HotSpot will ask target thread to pause at it's next safepoint, then capture the stack and let it resume. It's a local safepoint, so only that thread will be paused and hopefully it's clear why we cannot use it when called on currentThread! When called on current thread, it will use `Throwable.getStackTrace` implementation from 1.
4. [java.lang.Thread.getAllStackTraces()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2249) will call native [dumpThreads](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2271) that takes a snapshot of stacks of all running threads on that JVM, this is achieved by using global safepoint, essentially a stop-the-world event. The docs make it clear that at least some of the threads will continue executing while this method is called and snapshots might be taken at a different times. It does not include virtual threads. This is what tools like `jstack` and other VM level dumps use. It's fully implemented in HotSpot C++ code. 

5. JFR entirely separate implementation of stack walking, fully implemented in C++ and not creating StackTraceElement objects at all as they were deemed to heavy for the highly optimized code and compressed data format used in stack traces embedded in JFR events. 

As I mentioned earlier, we're going to concentrate on the simplest (but also very commonly used) point 1.  and add just a few lines of code that uses our `decoratingContext` to decorate the constructed StackTraceElement objects 

```java
@@ -561,6 +566,15 @@ static StackTraceElement[] of(Object x, int depth) {

	String context = Thread.currentDecoratingContext();
   if (context != null) {
        for (StackTraceElement ste : stackTrace) {
            ste.decoratingContext = context;
        }
	}	
```

inside the [StackTraceElement.of](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R569) method. It's as simple as that, just read the `currentDecoratingContext` and set it on a new field of STE objects, where it can later be used inside the `toString` method. Whole implementation can be found on my openjdk fork, [branch feature/simplest-decorator](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R569). I also added a jtreg unit test, as always a great way to document the new behaviour and convince yourself things are working as expected. 

With that in hand, all we need to do is build jdk using `make images`,  we can get back to our little [demo microservice](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/simplest-decorator?tab=readme-ov-file). Follow the README's [setup](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/simplest-decorator?tab=readme-ov-file#setup) instructions to point it to your freshly built openjdk binaries using gradle.properties: 

```sh 
org.gradle.java.installations.paths=/path/to/custom-jdk
```

and start the project. As we can see it's a Spring Boot service and we're using [DecoratingContextFilter](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/blob/696eee012930bfbbce5c27b6f7237abd8c420ac3/src/main/java/com/example/orders/DecoratingContextFilter.java#L16) to construct `decoratingContext` from the HttpServletRequest and set it on `currentThread`: 

```java

HttpServletRequest req = (HttpServletRequest) request;
String context = req.getMethod() + " " + req.getRequestURI();
Thread.currentThread().setDecoratingContext(context);

```

That's it! The service provides a bunch of endpoints that might throw an exception and print stack to logs:

```sh
curl http://localhost:8080/debug/orders/999
```

We also have some that will directly return a StackTrace to you, like `debug/thread-dump`: 

```sh 
 curl http://localhost:8080/debug/thread-dump
java.lang.Exception: Stack trace snapshot
	at com.example.orders.DebugController.threadDump(DebugController.java:37) [GET /debug/thread-dump]
	at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104) [GET /debug/thread-dump]
	at java.base/java.lang.reflect.Method.invoke(Method.java:565) [GET /debug/thread-dump]
	at org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:257) [GET /debug/thread-dump]
	at org.springframework.web.method.support.InvocableHandlerMethod.invokeForRequest(InvocableHandlerMethod.java:190) [GET /debug/thread-dump]
... 
	at org.apache.tomcat.util.net.SocketProcessorBase.run(SocketProcessorBase.java:52) [GET /debug/thread-dump]
	at org.apache.tomcat.util.threads.ThreadPoolExecutor.runWorker(ThreadPoolExecutor.java:1190) [GET /debug/thread-dump]
	at org.apache.tomcat.util.threads.ThreadPoolExecutor$Worker.run(ThreadPoolExecutor.java:659) [GET /debug/thread-dump]
	at org.apache.tomcat.util.threads.TaskThread$WrappingRunnable.run(TaskThread.java:63) [GET /debug/thread-dump]
	at java.base/java.lang.Thread.run(Thread.java:1530) [GET /debug/thread-dump]
```
and we can observe `[GET /debug/thread-dump]` being appended to each printed frame. There you go, stack trace decoration implemented. It wasn't that hard after all! 
 
Of course there are several problems with this, like that we have the same `decorating context` for all frames on a given thread, which is not that terribly useful, etc.  The main and perhaps less obvious problem though is that we're reading the decorating context from the current Thread object at the point in time of StackTrace is created and not when the stack is dumped, like when exception is thrown. That means in most of our very dynamic in nature use cases, there is a big chance that the decorating context was already changed. That really wouldn't work for virtual threads, async and reactive code ideas we covered in the introduction. 
What we need to do is capture the decorating context at the moment a backtrace, not stacktrace is created and use it create the stack trace. We'll address that in next part, after explaining in more detail what the last sentence meant. Before we move on though, I want to high light that as simple and full of problems this implementation is, it managed in fact to achive the goal of decorating JDK StackTraces with some runtime provided information and we managed to enrich frames with our `[HttpMethod url]` 
 
 

 
## What is Backtrace ? 
 
In a couple of previous sections, I referred to this thing called the Backtrace and how it's involved in constructing the StackTrace, but that it will be covered later. Well this sections is that later, now is the time to cover StackTrace vs Backtrace and we need both. Both are a data structure that represents call frames of user level (or application level, or .. not JVM level call frames) executing on JVM on given Thread. In both cases each call frame containing what you'd expect, some information about the method being called, where we are in this method's body. What's the difference than? They have different internal representation (think memory data format) and the sole reason Backtrace exists as far as I'm aware, is to make capturing the call stack of newly created Exception (Throwable to be specific) as fast as possible without losing any information. At this stage it's also worth highlighting that constructing the full StackTrace which can be printed to format familiar to most people who at least occasionally look at logs and happen to run on JVM, constructing that StackTrace is a relatively expesive operation. Not only we need to allocate bunch of Java objects (StackTraceElement), but we also need to pull quite a lot of metadata together. We're starting the stack walking with a native HotSpot object like [javaVFrame](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/hotspot/share/runtime/vframe.hpp#L109) 

```cpp

class javaVFrame: public vframe {
 public:
  // JVM state
  virtual Method*                      method()         const = 0;
  virtual int                          bci()            const = 0;
//..
``` 
which contains a pointer to the Java `Method` in question and a `bci` for Byte Code Index. The latter as you can probably guess can tell us which instruction in the method's body we're currently "at", meaning either currently executing or more likely where we called a method above us in the stack and we're waiting for to return. This is very low level state and quite a lot of pointer chasing and general data loading needs to happen before we can translate that into a nice StackTraceElement object that can be printed like 

```sh
java.base/java.lang.reflect.Method.invoke(Method.java:565)
```
We need to follow the `Method*` to find the method name, also `InstanceKlass` behind it's `method_holder` where we can get the class name and source file, module, class loader, etc. Method will also hold a LineNumberTable which is used to convert `bci` to a source code line number. Arguably C++ is really fast at chasing pointers and most of those operations, besides maybe `bci` -> `lineno` conversion, are just that: following pointers to find already in memory class metadata. This is just to give you an idea of what needs to happen. The most expensive part is probably allocating all those Java String objects required to copy and store this information as fields of StackTraceElement (we can't use internal JVM pointers anymore!), plus of course actual StackTraceElement instance. And this is just for a single call frame!

How does HotSpot achieve the goal of exceptions being fast to throw and having detailed human readable stack traces? 

It's done by delaying as much work as possible till later, to avoid blocking the throwing Thread, which cannot continue until this operation is finished. The solution is the idea of `Backtrace`, which captures all needed information but it still uses the HotSpot native representation (think pointers to internal JVM metadata) and delays the conversion to Java friendly format for later. Until that happens [backtrace](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L129) is just a field on Throwable, storing a reference to an opaque Object with a following comment 

```java
/**
 * The JVM saves some indication of the stack backtrace in this slot.
 */
private transient Object backtrace;
   
```
which is one to say "please don't mess with it", but of course feel free to poke around in a debugger, next time you have an Exception at hand. 

StackTrace construction will happen if and when user code actually asks for it, usually by calling [Throwable.getStackTrace()](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L857) which will pass it's [backtrace](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L866) field.  Eventually [StackTraceElement.of](https://github.com/gregcaban/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L563) method calls into HotSpot and asks it to hydrate that backtrace object into a proper `StackTraceElement[]`. 

One important assumption behind this design is that in real life JVM applications there many more exceptions that are thrown, then ones that have their StackTrace printed, because for instance most exceptions are caught and the catch handler isn't always walking the stack trace. That means it's worth paying the extra complexity to make throwing new exceptions fast and only making clients pay as they go (as they walk? ). This also partially explains why there are multiple separate implementations of stack walking in JVM, as we hinted on in previous section. They're optimised for different use pattern. 

I'm going through all of this in a lot of detail, because 
- I personally find it very interesting to learn more about the internals of the API that many of us use almost every day
- For our stack decoration prototype we'll try to leverage this principle in our stack decorator prototype. We need to store extra metadata to enrich some frames, but we do want to delay the additional work as much as possible, at least for Throwables. 

## OTel use case
By this stage we've compiled our own custom JDK, built a very naive global stack trace decorator and learned a bit about the JVM internal handling of Java threads, although there is so much to be said about threads, stacks and other HotSpot machinery that makes our JVM app run, it's a topic we could spend a lot of time on. For instance, remember that HotSpot class class we used to get our method pointer and byte code index, it was called `javaVFrame`. Have you wondered what `V` stand might stand for? You guessed it, it's "Virtual". So you know, when people talk about new virtual threads vs platform threads, but if you're HotSpot all that Java stuff above you is pretty virtual.. 

Back to the main topic. We've shown how simple global per thread state (or "DecorationContext") could be used for enriching stack frames, but it's very hard to imagine how that toy example could be extended to cover some of those exciting use cases we talked about at the begining. Even if one has very good imagination, I wouldn't really blame you for not seeing how this approach could be used to enrich call frames with OTEL spanID and even helping developers understand very complicated stack traces produced by some async reactive framework built on virtual threads. So let's make it more concrete and try to implement a prototype of how could that work and how would it look like from the application perspective. That way we can have have a better feel of whether this would be a useful thing to build. 

Now don't get me wrong, this is still going to be a toy prototype. Actually building something like this on a JDK is a serious engineering endevour and our goal here will be to build just enough to have a working demo, which is very far from production code. Having said that, if you're anything like me, you'll also find it fun and satisfying seeing something working end to end, not just sketching some APIs and diagrams. 

What's the demo? I like the idea of addressing the OTEL integration because it's a realistic use case people care about. If this solution could automatically enrich stack trace frames with traceID, spanID and maybe some attributes, that would demonstrate the value clearly. When I say automatically, I mean there was an JDK API that would allow OTEL and other telemetry libraries to push a `DecoratingContext` to HotSpot for say a method containg an OTEL span.  On a top of that, if the solution would also seamsly work with virtual thread, by propagating that context across different platform threads, that could be incredibly helpful those sometimes mind bending stack traces produced by various reactive frameworks or coroutines. 

Let's imagine we're building a Spring Boot microservice and we have that new type of OTEL annotation we can add to our endpoint handler, that looks something like this : 

```java
@DecorateStackTrace(
	value = "OperationName", 
	properties = {"arbitrary", "key", "value", "pairs"})

```

and that behind the scenes builds on top of annotations like OTEL [@WithSpan](https://opentelemetry.io/docs/zero-code/java/agent/annotations/#creating-spans-around-methods-with-withspan), creating spanId for this method etc. Only `@DecorateStackTrace` will also take care of calling our new JDK API and pushing a `DecoratingContext` on our thread, that will include current trace and span IDs, but also whatever additional attributes we provide. Then if we happen to throw an exception and print the stack into logs, for each frame with that annotation, we'd find 

```sh
java.lang.Exception:
	at com.example.myapp.MyController.myMethod(MyController.java:32) [trace=8cbd5293944f0d548fdc3a6577b3fc39 span=7a28297b7926b5b8 op=OperationName arbitrary=key value=pairs]
	at java.base/jdk.internal.reflect.Dir
... 
```
You get the idea! And it needs to work with virtual threads, regardless on which platform thread we started and where we eventually dumped the stack, the context must follow us. 
Hopefully it's pretty obvious that our first attempt at adding the decorating context would fail on this spectacularly. Not only it decorates all frames in the stack, while we'll only want to enrich the annotated methods, but it currently carries a single context and we want to add different metadata for different methods and maybe even different values for different calls to the same method, like some counters or other metrics. It's unclear how well it would handle the virtual thread scenario, it might actually work ok, since vthreads were so transparently integrated into existing API, but there is a bigger and more nuanced problem. In the section about [Backtrace](#backtrace) we explained the mechanism used to delay stack trace construction and in our naive simple decorator we modified only the latter to use `DecoratingContext` if we happen to find it on currentThread. Since we now understand those don't necesarily need to happen at the same time or even at the same thread, it's pretty obvious there is a problem. We could easily end up decorating the stack trace with wrong metadata. My idea is to evolve the simple decorator that grows a list of DecoratingContexts for each annotated method along with the call stack and when exception is thrown and backtrace captured on Throwable instance, we'll also transfer that list from thread to throwable. 


       Call Stack                         DecoratingContext Chain

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
    
    
Every time we call an method annotated with `@DecorateStackTrace` we push new context onto our list along with provided metadata. When we generate stack trace, we walk the stack top to bottom and if method on the frame matches DecoratingContext currently at the head of our list, pop that value and use it decorate the frame. Very simple and leaving a lot of responsiblity on the client, they're responsible for making sure that for each relevant call site, they only push one decorating context. If they get it wrong, they're stack trace will look odd, but hopefully that's something that's fairly easy to fix and we're leaving them the ability to fix it, instead of trying to manage it from the JVM side. 

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

Finally to make sure we don't introduce any unnecessary slow downs into that highly optimized code, we're going to implement this stack frame to context matching in native HotSpot code along, extending native methods called during stack trace construction like [StackTraceElement::initStackTraceElements](https://github.com/openjdk/jdk/blob/814b7f5d2a76288b6a8d6510a10c0241fdb727d0/src/java.base/share/classes/java/lang/StackTraceElement.java#L563). Thanks to that decision the changes were fairly minimal, could re-use existing stack walking loop and only add fast matching logic (comparison of `Method*` pointers between backtrace frame and context, which is about as fast as possible), without a need to introduce additional pass in Java. The other added benefit of implementing it in C++, was the fact that I could reuse a lot of the code (and definitely the pattern) between the two main stack trace building implementations in JDK, there are quite a few remember? I ended up implementing one called from `Throwable` and `Thread::getStackTrace()` / `java.lang.Thread.getAllStackTraces()`. The latter two methods capture stack using JVM safepoints and that implementation was fully in C++, so it was necessary to extend them in HotSpot. I completely punted on the JFR implemention as it's very different. Bottom line, I implemented a working version of this on my fork of jdk, branch [feature/otel-decorator](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/otel-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R401). 

Also the [feature/otel-decorator](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/otel-decorator) branch of the demo service includes "fake" OTEL annotation and fully working microservice with several endpoints annotated like 

```java
@DecorateStackTrace(value = "getOrder", properties = {"layer", "controller", "component", "orders"})
@GetMapping(value = "/orders/{id}", produces = MediaType.TEXT_PLAIN_VALUE)
public String getOrder(@PathVariable long id)

```

that you can curl and see stack frames decorated with your metadata. 

```sh 
$ curl http://localhost:8080/debug/thread-dump

curl  http://localhost:8080/debug/orders/9090
  com.example.orders.OrderNotFoundException: Order not found: 9090
      at com.example.orders.DebugController.getOrder(DebugController.java:33) [trace=7e6cd1283f769a037fa424f003115968 span=80824c807fee5570 op=getOrder
  layer=controller component=orders]
      at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104)
      at java.base/java.lang.reflect.Method.invoke(Method.java:565)
      at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104)
      at java.base/java.lang.reflect.Method.invoke(Method.java:565)
    ...
    at com.example.orders.DecoratingContextFilter.doFilter(DecoratingContextFilter.java:60)
        [trace=a1b2c3... span=7f8a9b... service=order-svc op=GET /debug/thread-dump layer=filter component=http]
    ...

```
It works, feel free to take it for a spin. You will have to build a custom JDK in order to run though, but hopefully I provided detailed enough [instructions](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/otel-decorator?tab=readme-ov-file#prerequisites) on how to do that. 


One more thing we haven't mentioned: How can JVM now how to render `DecoratingContext` into String, since it's passed around as an opaque `Object` reference. We allow users to provide a new interface [StackTraceDecoratingContextRenderer.java](src/java.base/share/classes/java/lang/StackTraceDecoratingContextRenderer.java) with a single method 

```java 
String render(Object metadata);
```

and application can provide their own implementation of [it](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/otel-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R401) and set it globally on the JVM. It's then used to convert the opaque context into human readable string. 


