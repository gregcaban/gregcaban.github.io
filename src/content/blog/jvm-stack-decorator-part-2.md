---
title: 'Decorating JVM Stack Traces for Fun and Profit - Part 2'
description: 'How to extend OpenJDK to enrich stack traces with runtime metadata like OTEL trace IDs, span attributes, and application context.'
pubDate: 'Mar 17 2026'
---

## Intro
This is the second part of my mini series about decorating JVM stack traces, if you missed the [first part](/blog/jvm-stack-decorator) where we covered the background, motivation and goals of this project, you might want to revisit that before continuing. We're going to start with a little side quest and cover the basics of how to build a custom OpenJDK image, including small changes like extending existing JCL class. I'm also going to demonstrate how to use that image in a sample Java app. 
As our motivating example, I'm going to show how to extend current stack trace construction mechanisms by enriching frames with some global "decorating context", which can be provided by application on start up. We'll see that you can achieve that by making few targeted changes in `java.lang.Thread` and `java.lang.StackTraceElement` classes. This will be a prototype, aimed to demonstrate one of the use cases listed in part 1, namely the ability to decorate stack frames with application specific data, like server name, service instance Id or some other name relevant to your business domain. For my demo app, I'm going to build a simple Spring Boot microservice, so the obvious thing to show is how to decorate frames with request HttpMethod and Url, something like `[GET /debug/thread-dump]` after each stack frame:

```sh
java.lang.Exception: Stack trace snapshot
    at com.example.orders.DebugController.threadDump(DebugController.java:37) [GET /debug/thread-dump]
    at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:104) [GET /debug/thread-dump]
    at java.base/java.lang.reflect.Method.invoke(Method.java:565) [GET /debug/thread-dump]
    ...
```

I'm going to implement that by extending `java.lang.Thread` class with methods allowing clients to provide a `decoratingContext`, which if present will be used to decorate stack frames. Our microservice will need to call this new method as early as possible in the request handling pipeline and then every stack trace generated on that Thread will have enriched frames. 
This use case has an added advantage of being much more dynamic than some static global `decoratingContext`, something like server name or instance ID, that would be set up by an application on JVM startup and used from then on. Hopefully it's not hard to see that the example I'll walk you through is both more interesting and in fact this approach could easily be modified to cover the more static use case. It's also worth stating that this is a toy prototype. It is intentionally oversimplifying things and ignoring many issues, for the sake of code being small and easy to explain in a single blog post. Right now the main goal is to show an interesting demo and make the idea of stack trace decoration more tangible.  I'm going to cover some of the limitations later on, plus we're going to build a much more comprehensive decorator in next part.  Let's start by learning how to build a custom JVM image. 

## OpenJDK development 101 or how to build your own JVM
This section will cover how to set up your local development environment for OpenJDK, feel free to skip this part if this is something you're already familiar with. The  [official docs](https://github.com/openjdk/jdk/blob/master/doc/building.md) are actually really good, but I'm going to repeat the core steps plus cover some gotchas below. In theory, all you need to do is: 

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

In practice I've run into a few problems. 

### The Boot JDK Catch-22
`bash configure` is the script responsible for finding and setting up local dependencies. If you only have JDK 17 and 21 installed like I did, `configure` might struggle to find a compatible BootJDK and it will print something like this 

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
tar xzf jtreg-8.2.1+1.tar.gz

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


## Simplest stack decorator
What I'll cover now is to show the smallest example I could think of that both shows how to extend openjdk standard library (the [JCL](https://en.wikipedia.org/wiki/Java_Class_Library)) and demonstrates the main pattern of allowing application code to decorate JVM stack trace, by calling a new API and providing some application specific information. 

We want to extend JDK's stack trace construction logic enough to allow us to build a demo microservice that enriches stack traces with extra `POST /api/orders` added to the usual class, method and source file info. That demo exists and can be found [here](https://github.com/gregcaban/jvm-stack-trace-decorator-demo/tree/feature/simplest-decorator) if you're interested in getting a better sense of what we're aiming to build. It's also a good example of how to use our custom JDK image in Java app.

I'm going to focus now on openjdk changes required to build that demo app. At the high level what we need to build is:
1. Add a new public method or class allowing application to add its data to be used for stack trace decoration. I'm going to call this piece of data `decorating context` and for now it's going to be just a single String. 
1. Extend the logic where stack trace is constructed to check if `decorating context` was added and use it to decorate StackTraceElement objects
1. that's it, at least for now. It's that simple!

We're going to implement it in a simplest way possible and the new API will be just a couple of public methods and a String field on the familiar `java.lang.Thread` class. New methods are essentially a getter and setter for the new `String decoratingContext` field, you can find the changes [here](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-2a5b4b651fa41e70f7953f7ee06e964d8396fcd1fe5755a1609e81b3f84d9224R1812) on my fork of OpenJDK. 

Using this String in the logic that creates a stack trace is a bit more interesting as there are several code paths that produce `StackTraceElement[]` objects and they often have a completely different implementation. For this demo we're going to focus on the first, most common and simplest one to extend, completely ignoring the hard native C++ ones. Having said that it's still worth enumerating all of them: 
1. [java.lang.Throwable.getStackTrace(backtrace, depth)](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Throwable.java#L857), one you might be familiar with. It's most commonly used for generating stack for exceptions, but also often recommended as a fast way to dump current Thread's stack if needed. It internally calls [StackTraceElement.of](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L556) method which calls into HotSpot to populate the `StackTraceElement`s using data captured in backtrace. I'm going to cover stack trace vs backtrace in the next section. 

2. [java.lang.StackFrameInfo.toStackTraceElement()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackFrameInfo.java#L152) (used by [StackWalker](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/test/jdk/jdk/internal/vm/Continuation/java.base/java/lang/StackWalkerHelper.java#L60)) calls [StackTraceElement.of(StackFrameInfo)](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/StackTraceElement.java#L570) which allows users to lazily walk the stack without fully materialising all frames. This obviously could be much more efficient if you're only interested in finding a specific frame, hopefully near the top of the stack. This might give you an idea that eagerly creating StackTraceElement array is an expensive operation and you're not wrong about it. It was added in Java 9.

3. [java.lang.Thread.getStackTrace()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2206) when called on a instance other than [current thread](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2207), will call into [native HotSpot API](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2213) to materialize the stack trace. After this method is called the HotSpot will ask target thread to pause at its next safepoint, then capture the stack and let it resume. 
It's a thread-local safepoint, so only
that thread will be paused. When called on the current thread, that whole safepoint dance is unnecessary. We're already executing on the right thread with a perfectly valid stack. Because of that, when called on current thread, it will use `Throwable.getStackTrace` implementation from 1.
4. [java.lang.Thread.getAllStackTraces()](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2249) will call native [dumpThreads](https://github.com/openjdk/jdk/blob/8ef39a22d855d1b1aaeb39549f6e8413f362338b/src/java.base/share/classes/java/lang/Thread.java#L2271) that takes a snapshot of stacks of all running threads on that JVM, this is achieved by using global safepoint, essentially a stop-the-world event. The docs make it clear that at least some of the threads will continue executing while this method is called and snapshots might be taken at a different times. It does not include virtual threads. This is what tools like `jstack` and other VM level dumps use. It's fully implemented in HotSpot C++ code. 

5. JFR entirely separate implementation of stack walking, fully implemented in C++ and not creating StackTraceElement objects at all as they were deemed too heavy for the highly optimized code and compressed data format used in stack traces embedded in JFR events. 

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

inside the [StackTraceElement.of](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R569) method. It's as simple as that, just read the `currentDecoratingContext` and set it on a new field of STE objects, where it can later be used inside the `toString` method. The whole implementation can be found on my openjdk fork, [branch feature/simplest-decorator](https://github.com/openjdk/jdk/compare/master...gregcaban:jdk:feature/simplest-decorator#diff-ceca337a263f4e992f604f815d173a56ed10b44a639efdb326e8bf32f68ac5c6R569). I also added a jtreg unit test, as always a great way to document the new behaviour and convince yourself things are working as expected. 

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

We also have some that will directly return a stack trace to you, like `debug/thread-dump`: 

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
 
Of course there are several problems with this, like that we have the same `decorating context` for all frames on a given thread, which is not that terribly useful, etc.  The main and perhaps less obvious problem though is that we're reading the decorating context from the current Thread object at the point in time when the stack trace is created and not when the stack is dumped, like when exception is thrown. That means in most of our very dynamic in nature use cases, there is a big chance that the decorating context was already changed. That really wouldn't work for virtual threads, async and reactive code ideas we covered in the introduction. 
What we need to do is capture the decorating context at the moment a backtrace, not stack trace, is created and use it create the stack trace. I'll address that in [part 3](/blog/jvm-stack-decorator-part-3), after explaining in more detail what the last sentence meant. Before we move on though, I want to highlight that as simple and full of problems this implementation is, it managed in fact to achieve the goal of decorating JDK stack traces with some runtime provided information and we managed to enrich frames with our `[HttpMethod url]` 
 
 
