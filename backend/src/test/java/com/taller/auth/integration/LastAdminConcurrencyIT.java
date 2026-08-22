package com.taller.auth.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import com.taller.auth.exception.LastAdminException;
import com.taller.auth.model.Role;
import com.taller.auth.model.User;
import com.taller.auth.repository.UserRepository;
import com.taller.auth.service.UserService;

@SpringBootTest
@ActiveProfiles("postgres-it")
class LastAdminConcurrencyIT {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private UserService userService;

    private final ExecutorService executor =
            Executors.newFixedThreadPool(2);

    @AfterEach
    void shutdownExecutor() {
        executor.shutdownNow();
    }

    @Test
    void dosBajasConcurrentesNuncaDejanCeroAdministradores() throws Exception {

        User adminBootstrap = userRepository
                .findByUsernameAndActiveTrue("admin")
                .orElseThrow();

        User segundoAdmin = new User(
                "admin-concurrente-" + System.nanoTime(),
                "hash"
        );

        segundoAdmin.setRole(Role.ADMIN);
        segundoAdmin = userRepository.saveAndFlush(segundoAdmin);

        Long admin1 = adminBootstrap.getId();
        Long admin2 = segundoAdmin.getId();

        CountDownLatch listos = new CountDownLatch(2);
        CountDownLatch comenzar = new CountDownLatch(1);

        List<Throwable> errores =
                Collections.synchronizedList(new ArrayList<>());

        Future<?> primera = executor.submit(() -> {
            listos.countDown();
            esperar(comenzar);

            try {
                userService.deactivate(admin1);
            } catch (Throwable t) {
                errores.add(t);
            }
        });

        Future<?> segunda = executor.submit(() -> {
            listos.countDown();
            esperar(comenzar);

            try {
                userService.deactivate(admin2);
            } catch (Throwable t) {
                errores.add(t);
            }
        });

        assertThat(
                listos.await(5, TimeUnit.SECONDS)
        ).isTrue();

        comenzar.countDown();

        primera.get(10, TimeUnit.SECONDS);
        segunda.get(10, TimeUnit.SECONDS);

        long adminsActivos =
                userRepository.countByRoleAndActiveTrue(Role.ADMIN);

        assertThat(adminsActivos).isEqualTo(1);
        assertThat(errores).hasSize(1);
        assertThat(errores.get(0))
                .isInstanceOf(LastAdminException.class);
    }

    private static void esperar(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
    }
}